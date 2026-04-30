import { v } from "convex/values"
import { query } from "./_generated/server"
import { requireTenant } from "./lib/tenant"

export const listForFile = query({
  args: { fileId: v.id("files"), limit: v.optional(v.number()) },
  handler: async (ctx, { fileId, limit }) => {
    const tc = await requireTenant(ctx)
    const cap = Math.min(limit ?? 50, 200)

    const events = await ctx.db
      .query("auditEvents")
      .withIndex("by_tenant_resource", (q) =>
        q
          .eq("tenantId", tc.tenantId)
          .eq("resourceType", "file")
          .eq("resourceId", fileId),
      )
      .order("desc")
      .take(cap)

    return events
  },
})

export const listForTenant = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const tc = await requireTenant(ctx)
    const cap = Math.min(limit ?? 100, 500)

    return await ctx.db
      .query("auditEvents")
      .withIndex("by_tenant_time", (q) => q.eq("tenantId", tc.tenantId))
      .order("desc")
      .take(cap)
  },
})
