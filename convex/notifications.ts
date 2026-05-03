/**
 * Per-member notification feed for the bell-icon dropdown.
 *
 * `fanOut` is invoked by code that wants to broadcast something to every member
 * of a tenant (extraction succeeded/failed, reconciliation result, file status
 * change). The header subscribes to `listForMe` and `unreadCount` for live
 * updates and the unread badge.
 */
import { ConvexError, v } from 'convex/values'
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from './_generated/server'
import type { Id } from './_generated/dataModel'
import { optionalTenant, requireTenant } from './lib/tenant'

export type NotificationSeed = {
  kind: string
  title: string
  body?: string
  severity?: 'info' | 'warn' | 'block' | 'ok'
  fileId?: Id<'files'>
  /**
   * Stable key used to collapse a noisy stream of related notifications into
   * a single bell row. Defaults to `${kind}:${fileId}` (or just `kind`) when
   * the caller doesn't pass one — that keeps the seven extractions on one
   * file folded into one entry.
   */
  groupKey?: string
  actorMemberId?: Id<'tenantMembers'>
  actorType?: string
}

function defaultGroupKey(seed: NotificationSeed): string {
  if (seed.groupKey) return seed.groupKey
  return seed.fileId ? `${seed.kind}:${seed.fileId}` : seed.kind
}

// Insert one row per member. Caller passes a tenantId + the seed; we resolve
// the tenant's members ourselves so callers don't need to thread a list
// around. Active members only — invited-but-never-signed-in folks don't get
// a feed entry until they accept.
export async function fanOutNotification(
  ctx: MutationCtx,
  tenantId: Id<'tenants'>,
  seed: NotificationSeed
) {
  const members = await ctx.db
    .query('tenantMembers')
    .withIndex('by_tenant_email', (q) => q.eq('tenantId', tenantId))
    .collect()

  const now = Date.now()
  const groupKey = defaultGroupKey(seed)
  for (const m of members) {
    if (m.status !== 'active') continue
    await ctx.db.insert('notifications', {
      tenantId,
      memberId: m._id,
      kind: seed.kind,
      title: seed.title,
      body: seed.body,
      severity: seed.severity,
      fileId: seed.fileId,
      groupKey,
      actorMemberId: seed.actorMemberId,
      actorType: seed.actorType ?? 'system',
      occurredAt: now,
    })
  }
}

// Internal entry point so other internalMutations can fan out without
// importing the helper directly (avoids cycles).
export const fanOutInternal = internalMutation({
  args: {
    tenantId: v.id('tenants'),
    kind: v.string(),
    title: v.string(),
    body: v.optional(v.string()),
    severity: v.optional(
      v.union(
        v.literal('info'),
        v.literal('warn'),
        v.literal('block'),
        v.literal('ok')
      )
    ),
    fileId: v.optional(v.id('files')),
    groupKey: v.optional(v.string()),
    actorMemberId: v.optional(v.id('tenantMembers')),
    actorType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await fanOutNotification(ctx, args.tenantId, {
      kind: args.kind,
      title: args.title,
      body: args.body,
      severity: args.severity,
      fileId: args.fileId,
      groupKey: args.groupKey,
      actorMemberId: args.actorMemberId,
      actorType: args.actorType,
    })
  },
})

// ─────────────────────────────────────────────────────────────────────
// Reader queries (current member only)
// ─────────────────────────────────────────────────────────────────────

const RECENT_LIMIT = 200

export const listForMe = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    // Subscribed by the notifications bell on every authenticated route, so
    // it fires during transient auth states (initial JWT handshake, the
    // setActive dance on first login). Use optionalTenant so those phases
    // resolve as "no notifications yet" instead of logged ConvexErrors.
    const tc = await optionalTenant(ctx)
    if (!tc) return []
    const cap = Math.min(limit ?? 30, 100)
    return await ctx.db
      .query('notifications')
      .withIndex('by_tenant_member_time', (q) =>
        q.eq('tenantId', tc.tenantId).eq('memberId', tc.memberId)
      )
      .order('desc')
      .take(cap)
  },
})

export const unreadCount = query({
  args: {},
  handler: async (ctx) => {
    const tc = await optionalTenant(ctx)
    if (!tc) return 0
    const recent = await ctx.db
      .query('notifications')
      .withIndex('by_tenant_member_time', (q) =>
        q.eq('tenantId', tc.tenantId).eq('memberId', tc.memberId)
      )
      .order('desc')
      .take(RECENT_LIMIT)
    return recent.filter((n) => n.readAt === undefined).length
  },
})

// Bell-summary query: a single subscription powering the badge. Returns the
// total unread count, the count of unread blockers (severity=block), and
// the count of distinct file/kind groups represented in the unread set so
// the bell can show "3 issues across 2 files" instead of "7 notifications".
export const unreadSummary = query({
  args: {},
  handler: async (ctx) => {
    const tc = await optionalTenant(ctx)
    if (!tc) {
      return { total: 0, blockers: 0, warnings: 0, groups: 0 }
    }
    const recent = await ctx.db
      .query('notifications')
      .withIndex('by_tenant_member_time', (q) =>
        q.eq('tenantId', tc.tenantId).eq('memberId', tc.memberId)
      )
      .order('desc')
      .take(RECENT_LIMIT)
    let total = 0
    let blockers = 0
    let warnings = 0
    const groupSet = new Set<string>()
    for (const n of recent) {
      if (n.readAt !== undefined) continue
      total++
      if (n.severity === 'block') blockers++
      else if (n.severity === 'warn') warnings++
      const key = n.groupKey ?? n.kind
      groupSet.add(key)
    }
    return { total, blockers, warnings, groups: groupSet.size }
  },
})

// Grouped feed: collapse a noisy stream into one row per group, with the
// most-recent member surfaced as the headline. Powers the bell dropdown.
export const groupedForMe = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const tc = await optionalTenant(ctx)
    if (!tc) return []
    const cap = Math.min(limit ?? 80, RECENT_LIMIT)
    const rows = await ctx.db
      .query('notifications')
      .withIndex('by_tenant_member_time', (q) =>
        q.eq('tenantId', tc.tenantId).eq('memberId', tc.memberId)
      )
      .order('desc')
      .take(cap)

    type Item = (typeof rows)[number]
    type Group = {
      groupKey: string
      kind: string
      fileId?: Id<'files'>
      headline: Item
      members: Item[]
      latestAt: number
      unread: number
      blockers: number
      warnings: number
    }
    const order: string[] = []
    const groups = new Map<string, Group>()
    for (const n of rows) {
      const key = n.groupKey ?? `${n.kind}:${n.fileId ?? 'noFile'}:${n._id}`
      let g = groups.get(key)
      if (!g) {
        g = {
          groupKey: key,
          kind: n.kind,
          fileId: n.fileId,
          headline: n,
          members: [],
          latestAt: n.occurredAt,
          unread: 0,
          blockers: 0,
          warnings: 0,
        }
        groups.set(key, g)
        order.push(key)
      }
      g.members.push(n)
      if (n.occurredAt > g.latestAt) {
        g.latestAt = n.occurredAt
        g.headline = n
      }
      if (n.readAt === undefined) g.unread++
      if (n.severity === 'block') g.blockers++
      else if (n.severity === 'warn') g.warnings++
    }
    return order.map((k) => groups.get(k)!).map((g) => ({
      groupKey: g.groupKey,
      kind: g.kind,
      fileId: g.fileId ?? null,
      headline: {
        _id: g.headline._id,
        title: g.headline.title,
        body: g.headline.body ?? null,
        severity: g.headline.severity ?? null,
        kind: g.headline.kind,
        fileId: g.headline.fileId ?? null,
        occurredAt: g.headline.occurredAt,
        readAt: g.headline.readAt ?? null,
      },
      memberIds: g.members.map((m) => m._id),
      count: g.members.length,
      latestAt: g.latestAt,
      unread: g.unread,
      blockers: g.blockers,
      warnings: g.warnings,
    }))
  },
})

// ─────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────

export const markRead = mutation({
  args: { notificationId: v.id('notifications') },
  handler: async (ctx, { notificationId }) => {
    const tc = await requireTenant(ctx)
    const n = await ctx.db.get(notificationId)
    if (!n || n.tenantId !== tc.tenantId || n.memberId !== tc.memberId) {
      throw new ConvexError('NOTIFICATION_NOT_FOUND')
    }
    if (n.readAt !== undefined) return { ok: true, alreadyRead: true }
    await ctx.db.patch(notificationId, { readAt: Date.now() })
    return { ok: true, alreadyRead: false }
  },
})

// Mark every notification in a group as read in one round-trip. The bell
// invokes this when the user clicks a collapsed group — no need to make N
// markRead calls for each row in the cluster.
export const markGroupRead = mutation({
  args: { groupKey: v.string() },
  handler: async (ctx, { groupKey }) => {
    const tc = await requireTenant(ctx)
    const recent = await ctx.db
      .query('notifications')
      .withIndex('by_tenant_member_time', (q) =>
        q.eq('tenantId', tc.tenantId).eq('memberId', tc.memberId)
      )
      .order('desc')
      .take(RECENT_LIMIT)
    const now = Date.now()
    let marked = 0
    for (const n of recent) {
      const key = n.groupKey ?? n.kind
      if (key !== groupKey) continue
      if (n.readAt !== undefined) continue
      await ctx.db.patch(n._id, { readAt: now })
      marked++
    }
    return { ok: true, marked }
  },
})

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)
    const recent = await ctx.db
      .query('notifications')
      .withIndex('by_tenant_member_time', (q) =>
        q.eq('tenantId', tc.tenantId).eq('memberId', tc.memberId)
      )
      .order('desc')
      .take(RECENT_LIMIT)
    const now = Date.now()
    let marked = 0
    for (const n of recent) {
      if (n.readAt === undefined) {
        await ctx.db.patch(n._id, { readAt: now })
        marked++
      }
    }
    return { ok: true, marked }
  },
})

export const dismiss = mutation({
  args: { notificationId: v.id('notifications') },
  handler: async (ctx, { notificationId }) => {
    const tc = await requireTenant(ctx)
    const n = await ctx.db.get(notificationId)
    if (!n || n.tenantId !== tc.tenantId || n.memberId !== tc.memberId) {
      throw new ConvexError('NOTIFICATION_NOT_FOUND')
    }
    await ctx.db.delete(notificationId)
    return { ok: true }
  },
})

// Dismiss every member of a group at once. Mirrors markGroupRead so the bell
// can offer an "X clear" affordance per group without a fan-out of mutations.
export const dismissGroup = mutation({
  args: { groupKey: v.string() },
  handler: async (ctx, { groupKey }) => {
    const tc = await requireTenant(ctx)
    const recent = await ctx.db
      .query('notifications')
      .withIndex('by_tenant_member_time', (q) =>
        q.eq('tenantId', tc.tenantId).eq('memberId', tc.memberId)
      )
      .order('desc')
      .take(RECENT_LIMIT)
    let removed = 0
    for (const n of recent) {
      const key = n.groupKey ?? n.kind
      if (key !== groupKey) continue
      await ctx.db.delete(n._id)
      removed++
    }
    return { ok: true, removed }
  },
})

export const dismissAll = mutation({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)
    let cursor: string | null = null
    let removed = 0
    while (true) {
      const page = await ctx.db
        .query('notifications')
        .withIndex('by_tenant_member_time', (q) =>
          q.eq('tenantId', tc.tenantId).eq('memberId', tc.memberId)
        )
        .paginate({ numItems: 100, cursor })
      for (const n of page.page) {
        await ctx.db.delete(n._id)
        removed++
      }
      if (page.isDone) break
      cursor = page.continueCursor
    }
    return { ok: true, removed }
  },
})
