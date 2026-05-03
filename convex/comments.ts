/**
 * Per-file internal comments with @-mention notifications.
 *
 * Mentions look like `@email@example.com` (the email is the unique key on
 * tenantMembers, so resolution is unambiguous). The mutation resolves each
 * mention to a memberId, persists the set on the row, and fans out a
 * notification per mentioned member so they get bell + queue surfacing.
 */
import { ConvexError, v } from 'convex/values'
import { mutation, query, type MutationCtx } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import { optionalTenant, requireRole, requireTenant } from './lib/tenant'
import { recordAudit } from './lib/audit'

const editorRoles = ['owner', 'admin', 'processor', 'closer', 'reviewer'] as const

const MAX_BODY = 4000

// Capture `@email@host.tld` (or `@local-part`). Greedy on the email side so
// "@a@b.c.d" works, stops at whitespace / common punctuation.
const MENTION_RE = /@([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/g

async function resolveMentions(
  ctx: MutationCtx,
  tenantId: Id<'tenants'>,
  body: string
): Promise<{
  emails: ReadonlyArray<string>
  members: ReadonlyArray<Doc<'tenantMembers'>>
}> {
  const seen = new Set<string>()
  for (const match of body.matchAll(MENTION_RE)) {
    const email = match[1]?.toLowerCase()
    if (email) seen.add(email)
  }
  if (seen.size === 0) return { emails: [], members: [] }

  const found: Doc<'tenantMembers'>[] = []
  for (const email of seen) {
    const m = await ctx.db
      .query('tenantMembers')
      .withIndex('by_tenant_email', (q) =>
        q.eq('tenantId', tenantId).eq('email', email)
      )
      .unique()
    if (m && m.status === 'active') found.push(m)
  }
  return { emails: [...seen], members: found }
}

function snippet(body: string): string {
  const single = body.replace(/\s+/g, ' ').trim()
  return single.length <= 160 ? single : `${single.slice(0, 159)}…`
}

export const create = mutation({
  args: {
    fileId: v.id('files'),
    body: v.string(),
  },
  handler: async (ctx, { fileId, body }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    const file = await ctx.db.get(fileId)
    if (!file || file.tenantId !== tc.tenantId) {
      throw new ConvexError('FILE_NOT_FOUND')
    }
    const trimmed = body.trim()
    if (!trimmed) throw new ConvexError('COMMENT_EMPTY')
    if (trimmed.length > MAX_BODY) throw new ConvexError('COMMENT_TOO_LONG')

    const { members } = await resolveMentions(ctx, tc.tenantId, trimmed)
    const now = Date.now()

    const commentId = await ctx.db.insert('fileComments', {
      tenantId: tc.tenantId,
      fileId,
      authorMemberId: tc.memberId,
      body: trimmed,
      mentionedMemberIds: members.map((m) => m._id),
      createdAt: now,
    })

    await recordAudit(ctx, tc, 'comment.created', 'file', fileId, {
      commentId,
      mentionCount: members.length,
    })

    // One notification per mentioned member, scoped to *that* member only —
    // mentions are 1:1, not tenant-wide. Skip self-mentions; not actionable.
    const now2 = Date.now()
    for (const m of members) {
      if (m._id === tc.memberId) continue
      await ctx.db.insert('notifications', {
        tenantId: tc.tenantId,
        memberId: m._id,
        kind: 'comment.mentioned',
        title: `Mentioned on ${file.fileNumber}`,
        body: snippet(trimmed),
        severity: 'info',
        fileId,
        groupKey: `comment.mentioned:${fileId}:${m._id}`,
        actorMemberId: tc.memberId,
        actorType: 'user',
        occurredAt: now2,
      })
    }

    return { ok: true, commentId, mentioned: members.length }
  },
})

export const edit = mutation({
  args: {
    commentId: v.id('fileComments'),
    body: v.string(),
  },
  handler: async (ctx, { commentId, body }) => {
    const tc = await requireTenant(ctx)
    const c = await ctx.db.get(commentId)
    if (!c || c.tenantId !== tc.tenantId) {
      throw new ConvexError('COMMENT_NOT_FOUND')
    }
    if (c.deletedAt) throw new ConvexError('COMMENT_DELETED')
    if (c.authorMemberId !== tc.memberId) {
      throw new ConvexError('COMMENT_NOT_YOURS')
    }
    const trimmed = body.trim()
    if (!trimmed) throw new ConvexError('COMMENT_EMPTY')
    if (trimmed.length > MAX_BODY) throw new ConvexError('COMMENT_TOO_LONG')

    const { members } = await resolveMentions(ctx, tc.tenantId, trimmed)
    await ctx.db.patch(commentId, {
      body: trimmed,
      mentionedMemberIds: members.map((m) => m._id),
      editedAt: Date.now(),
    })
    return { ok: true }
  },
})

export const remove = mutation({
  args: { commentId: v.id('fileComments') },
  handler: async (ctx, { commentId }) => {
    const tc = await requireTenant(ctx)
    const c = await ctx.db.get(commentId)
    if (!c || c.tenantId !== tc.tenantId) {
      throw new ConvexError('COMMENT_NOT_FOUND')
    }
    // Author or owner/admin can delete.
    const canForceDelete = tc.role === 'owner' || tc.role === 'admin'
    if (c.authorMemberId !== tc.memberId && !canForceDelete) {
      throw new ConvexError('COMMENT_NOT_YOURS')
    }
    await ctx.db.patch(commentId, { deletedAt: Date.now() })
    return { ok: true }
  },
})

export const listForFile = query({
  args: { fileId: v.id('files') },
  handler: async (ctx, { fileId }) => {
    const tc = await optionalTenant(ctx)
    if (!tc) return []
    const rows = await ctx.db
      .query('fileComments')
      .withIndex('by_tenant_file_time', (q) =>
        q.eq('tenantId', tc.tenantId).eq('fileId', fileId)
      )
      .order('asc')
      .take(200)
    // Pull author + mentioned member emails for display.
    const memberIds = new Set<Id<'tenantMembers'>>()
    for (const c of rows) {
      memberIds.add(c.authorMemberId)
      for (const m of c.mentionedMemberIds) memberIds.add(m)
    }
    const memberById = new Map<Id<'tenantMembers'>, Doc<'tenantMembers'>>()
    for (const id of memberIds) {
      const m = await ctx.db.get(id)
      if (m) memberById.set(id, m)
    }
    return rows.map((c) => ({
      _id: c._id,
      body: c.body,
      createdAt: c.createdAt,
      editedAt: c.editedAt ?? null,
      deletedAt: c.deletedAt ?? null,
      authorMemberId: c.authorMemberId,
      authorEmail: memberById.get(c.authorMemberId)?.email ?? null,
      isMine: c.authorMemberId === tc.memberId,
      mentioned: c.mentionedMemberIds
        .map((id) => memberById.get(id))
        .filter((m): m is Doc<'tenantMembers'> => !!m)
        .map((m) => ({ _id: m._id, email: m.email })),
    }))
  },
})

// Mention-suggestion query: typeahead returns active members of the tenant
// whose email matches the query. The current member is filtered out —
// self-mentions are spam (the server skips them on fanout anyway), so
// hiding them in the picker keeps the choices honest.
export const suggestMentions = query({
  args: { q: v.optional(v.string()) },
  handler: async (ctx, { q }) => {
    const tc = await optionalTenant(ctx)
    if (!tc) return []
    const lc = (q ?? '').trim().toLowerCase()
    const all = await ctx.db
      .query('tenantMembers')
      .withIndex('by_tenant_email', (qb) => qb.eq('tenantId', tc.tenantId))
      .take(50)
    return all
      .filter((m) => m.status === 'active')
      .filter((m) => m._id !== tc.memberId)
      .filter((m) => (lc ? m.email.toLowerCase().includes(lc) : true))
      .slice(0, 8)
      .map((m) => ({ _id: m._id, email: m.email, role: m.role }))
  },
})
