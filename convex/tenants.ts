import { ConvexError, v } from "convex/values"
import { mutation, query } from "./_generated/server"
import { authComponent } from "./auth"
import { requireTenant } from "./lib/tenant"

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

function audit(metadata: Record<string, unknown> = {}) {
  return { metadata, occurredAt: Date.now() }
}

export const create = mutation({
  args: {
    slug: v.string(),
    legalName: v.string(),
  },
  handler: async (ctx, { slug, legalName }) => {
    if (!SLUG_RE.test(slug)) throw new ConvexError("INVALID_SLUG")
    if (legalName.trim().length < 2) throw new ConvexError("INVALID_LEGAL_NAME")

    const authUser = await authComponent.getAuthUser(ctx)

    const existing = await ctx.db
      .query("tenants")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique()
    if (existing) throw new ConvexError("SLUG_TAKEN")

    const now = Date.now()
    const tenantId = await ctx.db.insert("tenants", {
      slug,
      legalName,
      status: "trial",
      plan: "trial",
      createdAt: now,
    })

    const memberId = await ctx.db.insert("tenantMembers", {
      tenantId,
      betterAuthUserId: authUser._id,
      email: authUser.email,
      role: "owner",
      canViewNpi: true,
      status: "active",
    })

    const prefs = await ctx.db
      .query("userPreferences")
      .withIndex("by_betterAuthUser", (q) =>
        q.eq("betterAuthUserId", authUser._id),
      )
      .unique()
    if (prefs) {
      await ctx.db.patch(prefs._id, { activeTenantId: tenantId })
    } else {
      await ctx.db.insert("userPreferences", {
        betterAuthUserId: authUser._id,
        activeTenantId: tenantId,
      })
    }

    await ctx.db.insert("auditEvents", {
      tenantId,
      actorMemberId: memberId,
      actorType: "user",
      action: "tenant.created",
      resourceType: "tenant",
      resourceId: tenantId,
      ...audit({ slug, legalName }),
    })

    return { tenantId, memberId }
  },
})

export const setActive = mutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const authUser = await authComponent.getAuthUser(ctx)

    const member = await ctx.db
      .query("tenantMembers")
      .withIndex("by_betterAuthUser_tenant", (q) =>
        q.eq("betterAuthUserId", authUser._id).eq("tenantId", tenantId),
      )
      .unique()
    if (!member || member.status !== "active") {
      throw new ConvexError("NOT_A_MEMBER")
    }

    const prefs = await ctx.db
      .query("userPreferences")
      .withIndex("by_betterAuthUser", (q) =>
        q.eq("betterAuthUserId", authUser._id),
      )
      .unique()
    if (prefs) {
      await ctx.db.patch(prefs._id, { activeTenantId: tenantId })
    } else {
      await ctx.db.insert("userPreferences", {
        betterAuthUserId: authUser._id,
        activeTenantId: tenantId,
      })
    }
    return { ok: true }
  },
})

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const authUser = await authComponent.safeGetAuthUser(ctx)
    if (!authUser) return { memberships: [], activeTenantId: null }

    const memberships = await ctx.db
      .query("tenantMembers")
      .withIndex("by_betterAuthUser", (q) =>
        q.eq("betterAuthUserId", authUser._id),
      )
      .take(50)

    const tenants = await Promise.all(
      memberships.map(async (m) => {
        const t = await ctx.db.get(m.tenantId)
        return t
          ? {
              tenantId: t._id,
              slug: t.slug,
              legalName: t.legalName,
              status: t.status,
              role: m.role,
            }
          : null
      }),
    )

    const prefs = await ctx.db
      .query("userPreferences")
      .withIndex("by_betterAuthUser", (q) =>
        q.eq("betterAuthUserId", authUser._id),
      )
      .unique()

    return {
      memberships: tenants.filter((t): t is NonNullable<typeof t> => !!t),
      activeTenantId: prefs?.activeTenantId ?? null,
    }
  },
})

export const current = query({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)
    const tenant = await ctx.db.get(tc.tenantId)
    if (!tenant) throw new ConvexError("TENANT_NOT_FOUND")
    return {
      tenantId: tenant._id,
      slug: tenant.slug,
      legalName: tenant.legalName,
      status: tenant.status,
      plan: tenant.plan,
      role: tc.role,
      canViewNpi: tc.canViewNpi,
    }
  },
})
