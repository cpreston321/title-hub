import { v } from 'convex/values'
import { paginationOptsValidator } from 'convex/server'
import { query } from './_generated/server'
import { components } from './_generated/api'
import { optionalTenant, requireTenant } from './lib/tenant'
import type { Doc, Id } from './_generated/dataModel'

type ActorInfo =
  | {
      kind: 'member'
      memberId: Id<'tenantMembers'>
      email: string
      name: string | null
      role: string
    }
  | { kind: 'system' }
  | { kind: 'unknown'; type: string }

type FileContext = {
  fileId: Id<'files'>
  fileNumber: string
  propertyAddressLine1: string | null
  city: string | null
  state: string | null
} | null

export const listForFile = query({
  args: { fileId: v.id('files'), limit: v.optional(v.number()) },
  handler: async (ctx, { fileId, limit }) => {
    const tc = await requireTenant(ctx)
    const cap = Math.min(limit ?? 50, 200)

    const events = await ctx.db
      .query('auditEvents')
      .withIndex('by_tenant_resource', (q) =>
        q
          .eq('tenantId', tc.tenantId)
          .eq('resourceType', 'file')
          .eq('resourceId', fileId)
      )
      .order('desc')
      .take(cap)

    return await enrichEvents(ctx, events)
  },
})

export const listForTenant = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    // Subscribed by the dashboard's "Recently" feed, which is reachable
    // before tenant-resolution settles on first login. Use optionalTenant
    // so the initial render doesn't log a NO_ACTIVE_TENANT.
    const tc = await optionalTenant(ctx)
    if (!tc) return []
    const cap = Math.min(limit ?? 100, 500)

    const events = await ctx.db
      .query('auditEvents')
      .withIndex('by_tenant_time', (q) => q.eq('tenantId', tc.tenantId))
      .order('desc')
      .take(cap)

    return await enrichEvents(ctx, events)
  },
})

// Paginated history feed for the dedicated /history page. Same enrichment
// as listForTenant; the cursor is opaque and threaded by the client.
export const paginateForTenant = query({
  args: {
    paginationOpts: paginationOptsValidator,
    actionPrefix: v.optional(v.string()),
  },
  handler: async (ctx, { paginationOpts, actionPrefix }) => {
    const tc = await optionalTenant(ctx)
    if (!tc) {
      return { page: [], isDone: true, continueCursor: '' }
    }
    const result = await ctx.db
      .query('auditEvents')
      .withIndex('by_tenant_time', (q) => q.eq('tenantId', tc.tenantId))
      .order('desc')
      .paginate(paginationOpts)

    const filtered = actionPrefix
      ? result.page.filter((e) => e.action.startsWith(actionPrefix))
      : result.page

    const enriched = await enrichEvents(ctx, filtered)
    return {
      page: enriched,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    }
  },
})

async function enrichEvents(
  ctx: { db: any; runQuery: any },
  events: ReadonlyArray<Doc<'auditEvents'>>
) {
  const memberCache = new Map<
    string,
    { email: string; name: string | null; role: string } | null
  >()
  const fileCache = new Map<string, FileContext>()

  // Resolve the file context for an event, in this order:
  //   1. resourceType === 'file' → resourceId is the file id
  //   2. metadata.fileId → many cross-cutting events (extractions, comments,
  //      followups, finding actions, email-classifier-attached) carry it
  // Returns null when neither applies.
  const loadFile = async (
    event: Doc<'auditEvents'>
  ): Promise<FileContext> => {
    let fileId: string | null = null
    if (event.resourceType === 'file') {
      fileId = event.resourceId
    } else {
      const md = (event.metadata ?? {}) as Record<string, unknown>
      if (typeof md.fileId === 'string') fileId = md.fileId
    }
    if (!fileId) return null
    if (fileCache.has(fileId)) return fileCache.get(fileId) ?? null
    const file = (await ctx.db.get(fileId as Id<'files'>)) as
      | Doc<'files'>
      | null
    if (!file) {
      fileCache.set(fileId, null)
      return null
    }
    const ctx_: FileContext = {
      fileId: file._id,
      fileNumber: file.fileNumber,
      propertyAddressLine1: file.propertyAddress?.line1 ?? null,
      city: file.propertyAddress?.city ?? null,
      state: file.propertyAddress?.state ?? null,
    }
    fileCache.set(fileId, ctx_)
    return ctx_
  }

  const out: Array<
    Doc<'auditEvents'> & { actor: ActorInfo; file: FileContext }
  > = []
  for (const e of events) {
    let actor: ActorInfo =
      e.actorType === 'system'
        ? { kind: 'system' }
        : { kind: 'unknown', type: e.actorType }

    if (e.actorMemberId) {
      const key = e.actorMemberId
      let info = memberCache.get(key)
      if (info === undefined) {
        const member = await ctx.db.get(e.actorMemberId)
        if (member) {
          let name: string | null = null
          try {
            const user = (await ctx.runQuery(
              components.betterAuth.adapter.findOne,
              {
                model: 'user',
                where: [{ field: '_id', value: member.betterAuthUserId }],
              }
            )) as { name?: string | null } | null
            name = user?.name ?? null
          } catch {
            name = null
          }
          info = { email: member.email, name, role: member.role }
        } else {
          info = null
        }
        memberCache.set(key, info)
      }
      if (info) {
        actor = {
          kind: 'member',
          memberId: e.actorMemberId,
          email: info.email,
          name: info.name,
          role: info.role,
        }
      }
    }

    const file = await loadFile(e)
    out.push({ ...e, actor, file })
  }
  return out
}
