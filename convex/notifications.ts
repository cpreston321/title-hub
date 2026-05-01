/**
 * Per-member notification feed for the bell-icon dropdown.
 *
 * `fanOut` is invoked by code that wants to broadcast something to every
 * member of a tenant (extraction succeeded/failed, reconciliation result,
 * file status change). The header subscribes to `listForMe` and
 * `unreadCount` for live updates and the unread badge.
 */
import { ConvexError, v } from "convex/values"
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server"
import type { Id } from "./_generated/dataModel"
import { requireTenant } from "./lib/tenant"

export type NotificationSeed = {
  kind: string
  title: string
  body?: string
  severity?: "info" | "warn" | "block" | "ok"
  fileId?: Id<"files">
  actorMemberId?: Id<"tenantMembers">
  actorType?: string
}

// Insert one row per member. Caller passes a tenantId + the seed; we resolve
// the tenant's members ourselves so callers don't need to thread a list
// around. Active members only — invited-but-never-signed-in folks don't get
// a feed entry until they accept.
export async function fanOutNotification(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  seed: NotificationSeed,
) {
  const members = await ctx.db
    .query("tenantMembers")
    .withIndex("by_tenant_email", (q) => q.eq("tenantId", tenantId))
    .collect()

  const now = Date.now()
  for (const m of members) {
    if (m.status !== "active") continue
    await ctx.db.insert("notifications", {
      tenantId,
      memberId: m._id,
      kind: seed.kind,
      title: seed.title,
      body: seed.body,
      severity: seed.severity,
      fileId: seed.fileId,
      actorMemberId: seed.actorMemberId,
      actorType: seed.actorType ?? "system",
      occurredAt: now,
    })
  }
}

// Internal entry point so other internalMutations can fan out without
// importing the helper directly (avoids cycles).
export const fanOutInternal = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    kind: v.string(),
    title: v.string(),
    body: v.optional(v.string()),
    severity: v.optional(
      v.union(
        v.literal("info"),
        v.literal("warn"),
        v.literal("block"),
        v.literal("ok"),
      ),
    ),
    fileId: v.optional(v.id("files")),
    actorMemberId: v.optional(v.id("tenantMembers")),
    actorType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await fanOutNotification(ctx, args.tenantId, {
      kind: args.kind,
      title: args.title,
      body: args.body,
      severity: args.severity,
      fileId: args.fileId,
      actorMemberId: args.actorMemberId,
      actorType: args.actorType,
    })
  },
})

// ─────────────────────────────────────────────────────────────────────
// Reader queries (current member only)
// ─────────────────────────────────────────────────────────────────────

export const listForMe = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const tc = await requireTenant(ctx)
    const cap = Math.min(limit ?? 30, 100)
    return await ctx.db
      .query("notifications")
      .withIndex("by_tenant_member_time", (q) =>
        q.eq("tenantId", tc.tenantId).eq("memberId", tc.memberId),
      )
      .order("desc")
      .take(cap)
  },
})

export const unreadCount = query({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)
    // We index by (tenant, member, readAt, occurredAt). Unread rows have
    // readAt === undefined — Convex doesn't index undefined values, so we
    // count by walking the recent feed and filtering. Fast in practice
    // because we cap at 200 most-recent.
    const recent = await ctx.db
      .query("notifications")
      .withIndex("by_tenant_member_time", (q) =>
        q.eq("tenantId", tc.tenantId).eq("memberId", tc.memberId),
      )
      .order("desc")
      .take(200)
    return recent.filter((n) => n.readAt === undefined).length
  },
})

// ─────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────

export const markRead = mutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, { notificationId }) => {
    const tc = await requireTenant(ctx)
    const n = await ctx.db.get(notificationId)
    if (
      !n ||
      n.tenantId !== tc.tenantId ||
      n.memberId !== tc.memberId
    ) {
      throw new ConvexError("NOTIFICATION_NOT_FOUND")
    }
    if (n.readAt !== undefined) return { ok: true, alreadyRead: true }
    await ctx.db.patch(notificationId, { readAt: Date.now() })
    return { ok: true, alreadyRead: false }
  },
})

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)
    const recent = await ctx.db
      .query("notifications")
      .withIndex("by_tenant_member_time", (q) =>
        q.eq("tenantId", tc.tenantId).eq("memberId", tc.memberId),
      )
      .order("desc")
      .take(200)
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
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, { notificationId }) => {
    const tc = await requireTenant(ctx)
    const n = await ctx.db.get(notificationId)
    if (
      !n ||
      n.tenantId !== tc.tenantId ||
      n.memberId !== tc.memberId
    ) {
      throw new ConvexError("NOTIFICATION_NOT_FOUND")
    }
    await ctx.db.delete(notificationId)
    return { ok: true }
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
        .query("notifications")
        .withIndex("by_tenant_member_time", (q) =>
          q.eq("tenantId", tc.tenantId).eq("memberId", tc.memberId),
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
