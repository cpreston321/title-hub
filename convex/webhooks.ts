import { ConvexError, v } from "convex/values"
import {
  internalMutation,
  mutation,
  query,
} from "./_generated/server"
import { internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { requireRole, requireTenant } from "./lib/tenant"
import { recordAudit } from "./lib/audit"

const WEBHOOK_EVENTS = [
  "finding.created",
  "finding.resolved",
  "extraction.succeeded",
  "extraction.failed",
] as const

function newSecret(): string {
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")
}

export const addEndpoint = mutation({
  args: {
    url: v.string(),
    events: v.array(v.string()),
  },
  handler: async (ctx, { url, events }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, "owner", "admin")
    if (!/^https:\/\//.test(url)) throw new ConvexError("WEBHOOK_URL_NOT_HTTPS")
    const unknown = events.filter(
      (e) => !WEBHOOK_EVENTS.includes(e as (typeof WEBHOOK_EVENTS)[number]),
    )
    if (unknown.length > 0) {
      throw new ConvexError(`UNKNOWN_EVENT_TYPES:${unknown.join(",")}`)
    }
    const id = await ctx.db.insert("webhookEndpoints", {
      tenantId: tc.tenantId,
      url,
      events,
      secret: newSecret(),
      enabled: true,
      createdAt: Date.now(),
    })
    await recordAudit(ctx, tc, "webhook.endpoint_added", "webhook", id, {
      url,
      events,
    })
    return { endpointId: id }
  },
})

export const setEndpointEnabled = mutation({
  args: {
    endpointId: v.id("webhookEndpoints"),
    enabled: v.boolean(),
  },
  handler: async (ctx, { endpointId, enabled }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, "owner", "admin")
    const ep = await ctx.db.get(endpointId)
    if (!ep || ep.tenantId !== tc.tenantId) {
      throw new ConvexError("ENDPOINT_NOT_FOUND")
    }
    await ctx.db.patch(endpointId, { enabled })
    return { ok: true }
  },
})

export const listEndpoints = query({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)
    const rows = await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tc.tenantId))
      .take(50)
    // Strip secret from the public surface.
    return rows.map((r) => ({
      _id: r._id,
      url: r.url,
      events: r.events,
      enabled: r.enabled,
      createdAt: r.createdAt,
    }))
  },
})

// ─────────────────────────────────────────────────────────────────────
// Internal: enqueue dispatches
// ─────────────────────────────────────────────────────────────────────

export const enqueue = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    event: v.string(),
    payload: v.any(),
  },
  handler: async (ctx, { tenantId, event, payload }) => {
    const endpoints = await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .take(50)

    const targets = endpoints.filter(
      (e) => e.enabled && e.events.includes(event),
    )
    const ids: Array<Id<"webhookDeliveries">> = []
    for (const ep of targets) {
      const id = await ctx.db.insert("webhookDeliveries", {
        tenantId,
        endpointId: ep._id,
        event,
        payload,
        status: "pending",
        attemptCount: 0,
        createdAt: Date.now(),
      })
      ids.push(id)
      await ctx.scheduler.runAfter(
        0,
        internal.webhooksRunner.dispatchOne,
        { deliveryId: id },
      )
    }
    return { dispatched: ids.length }
  },
})

export const markDeliveryAttempt = internalMutation({
  args: {
    deliveryId: v.id("webhookDeliveries"),
    success: v.boolean(),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, { deliveryId, success, errorMessage }) => {
    const d = await ctx.db.get(deliveryId)
    if (!d) return
    await ctx.db.patch(deliveryId, {
      status: success ? "succeeded" : "failed",
      attemptCount: d.attemptCount + 1,
      lastAttemptAt: Date.now(),
      lastError: errorMessage,
    })
  },
})
