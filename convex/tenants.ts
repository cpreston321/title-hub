import { ConvexError, v } from 'convex/values'
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { components, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { optionalTenant, requireRole, requireTenant } from './lib/tenant'
import { recordAudit } from './lib/audit'

// ─────────────────────────────────────────────────────────────────────
// Better Auth trigger handlers (called from `triggers.organization.onCreate`
// and `triggers.member.onCreate` in convex/auth.ts).
// ─────────────────────────────────────────────────────────────────────

export const provisionFromBetterAuthOrg = internalMutation({
  args: {
    betterAuthOrgId: v.string(),
    slug: v.string(),
    legalName: v.string(),
  },
  handler: async (ctx, { betterAuthOrgId, slug, legalName }) => {
    const existing = await ctx.db
      .query('tenants')
      .withIndex('by_better_auth_org', (q) =>
        q.eq('betterAuthOrgId', betterAuthOrgId)
      )
      .unique()
    if (existing) return { tenantId: existing._id, alreadyProvisioned: true }

    const tenantId = await ctx.db.insert('tenants', {
      slug,
      legalName,
      status: 'trial',
      plan: 'trial',
      betterAuthOrgId,
      createdAt: Date.now(),
    })

    await ctx.db.insert('auditEvents', {
      tenantId,
      actorType: 'system',
      action: 'tenant.created',
      resourceType: 'tenant',
      resourceId: tenantId,
      metadata: { slug, legalName, betterAuthOrgId },
      occurredAt: Date.now(),
    })

    // Provision per-tenant CMK so NPI can be issued immediately.
    await ctx.runMutation(internal.secrets.provisionForTenant, { tenantId })

    return { tenantId, alreadyProvisioned: false }
  },
})

function mapBetterAuthRole(role: string): 'owner' | 'admin' | 'processor' {
  if (role === 'owner') return 'owner'
  if (role === 'admin') return 'admin'
  return 'processor'
}

export const provisionMemberFromBetterAuth = internalMutation({
  args: {
    betterAuthOrgId: v.string(),
    betterAuthUserId: v.string(),
    betterAuthRole: v.string(),
  },
  handler: async (
    ctx,
    { betterAuthOrgId, betterAuthUserId, betterAuthRole }
  ) => {
    const tenant = await ctx.db
      .query('tenants')
      .withIndex('by_better_auth_org', (q) =>
        q.eq('betterAuthOrgId', betterAuthOrgId)
      )
      .unique()
    if (!tenant) {
      console.warn(
        `[authTriggers] member onCreate fired before tenant existed: org=${betterAuthOrgId}`
      )
      return { memberId: null, alreadyProvisioned: false }
    }

    const existing = await ctx.db
      .query('tenantMembers')
      .withIndex('by_betterAuthUser_tenant', (q) =>
        q.eq('betterAuthUserId', betterAuthUserId).eq('tenantId', tenant._id)
      )
      .unique()
    if (existing) return { memberId: existing._id, alreadyProvisioned: true }

    // Best-effort fetch of the Better Auth user to denormalize email.
    const authUser = (await ctx.runQuery(
      components.betterAuth.adapter.findOne,
      {
        model: 'user',
        where: [{ field: '_id', value: betterAuthUserId }],
      }
    )) as { email?: string } | null
    const email = authUser?.email ?? `${betterAuthUserId}@unknown.local`

    const role = mapBetterAuthRole(betterAuthRole)

    const memberId = await ctx.db.insert('tenantMembers', {
      tenantId: tenant._id,
      betterAuthUserId,
      email,
      role,
      canViewNpi: role === 'owner' || role === 'admin',
      status: 'active',
    })

    await ctx.db.insert('auditEvents', {
      tenantId: tenant._id,
      actorMemberId: memberId,
      actorType: 'system',
      action: 'member.added',
      resourceType: 'tenant',
      resourceId: tenant._id,
      metadata: { betterAuthUserId, role, email },
      occurredAt: Date.now(),
    })

    return { memberId, alreadyProvisioned: false }
  },
})

// ─────────────────────────────────────────────────────────────────────
// Public queries / mutations
// ─────────────────────────────────────────────────────────────────────

// Whether the current user is a system admin (the only role allowed to
// create new organizations). UI uses this to gate the "Create org" form.
export const amISystemAdmin = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) return false
    const row = await ctx.db
      .query('systemAdmins')
      .withIndex('by_user', (q) => q.eq('betterAuthUserId', identity.subject))
      .unique()
    return !!row
  },
})

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) return { memberships: [], activeTenantId: null }
    const betterAuthUserId = identity.subject

    const memberships = await ctx.db
      .query('tenantMembers')
      .withIndex('by_betterAuthUser', (q) =>
        q.eq('betterAuthUserId', betterAuthUserId)
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
              betterAuthOrgId: t.betterAuthOrgId,
            }
          : null
      })
    )

    // Use the JWT's sessionId, not just userId — see requireTenant for the
    // full rationale. Multi-session users were seeing the wrong active org.
    const sessionId = identity.sessionId as string | undefined
    const session = sessionId
      ? ((await ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: 'session',
          where: [{ field: '_id', value: sessionId }],
        })) as { activeOrganizationId?: string | null } | null)
      : null

    let activeTenantId: Id<'tenants'> | null = null
    if (session?.activeOrganizationId) {
      const t = await ctx.db
        .query('tenants')
        .withIndex('by_better_auth_org', (q) =>
          q.eq('betterAuthOrgId', session.activeOrganizationId!)
        )
        .unique()
      activeTenantId = t?._id ?? null
    }

    return {
      memberships: tenants.filter((t): t is NonNullable<typeof t> => !!t),
      activeTenantId,
    }
  },
})

export const current = query({
  args: {},
  handler: async (ctx) => {
    // Returns null instead of throwing for the transient "not signed in /
    // no active org / not a member yet" states the dashboard subscribes
    // through on first paint. Real authorization failures are still caught
    // at the per-resource layer via `requireTenant`. Frontend treats null as
    // "show the org picker / redirect."
    const tc = await optionalTenant(ctx)
    if (!tc) return null
    const tenant = await ctx.db.get(tc.tenantId)
    if (!tenant) return null
    return {
      tenantId: tenant._id,
      slug: tenant.slug,
      legalName: tenant.legalName,
      status: tenant.status,
      plan: tenant.plan,
      memberId: tc.memberId,
      role: tc.role,
      canViewNpi: tc.canViewNpi,
      betterAuthOrgId: tenant.betterAuthOrgId,
    }
  },
})

// Members panel (admin-only). Lists app-side memberships for the active tenant.
export const listMembers = query({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)
    const members = await ctx.db
      .query('tenantMembers')
      .withIndex('by_tenant_email', (q) => q.eq('tenantId', tc.tenantId))
      .take(200)
    return members.map((m) => ({
      _id: m._id,
      email: m.email,
      role: m.role,
      canViewNpi: m.canViewNpi,
      status: m.status,
      betterAuthUserId: m.betterAuthUserId,
    }))
  },
})

export const setMemberRole = mutation({
  args: {
    memberId: v.id('tenantMembers'),
    role: v.union(
      v.literal('owner'),
      v.literal('admin'),
      v.literal('processor'),
      v.literal('closer'),
      v.literal('reviewer'),
      v.literal('readonly')
    ),
  },
  handler: async (ctx, { memberId, role }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner', 'admin')
    // A user can't change their own role — that's the classic
    // privilege-escalation / self-lockout vector. An owner can always
    // hand the role to another member who can then re-grant.
    if (memberId === tc.memberId) {
      throw new ConvexError('CANNOT_MODIFY_SELF')
    }
    const member = await ctx.db.get(memberId)
    if (!member || member.tenantId !== tc.tenantId) {
      throw new ConvexError('MEMBER_NOT_FOUND')
    }
    await ctx.db.patch(memberId, { role })
    await recordAudit(ctx, tc, 'member.role_changed', 'member', memberId, {
      from: member.role,
      to: role,
    })
    return { ok: true }
  },
})

export const setMemberNpiAccess = mutation({
  args: { memberId: v.id('tenantMembers'), canViewNpi: v.boolean() },
  handler: async (ctx, { memberId, canViewNpi }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner', 'admin')
    // Same self-modification rule as role changes: NPI access has to be
    // granted (or revoked) by another admin, never the holder themselves.
    if (memberId === tc.memberId) {
      throw new ConvexError('CANNOT_MODIFY_SELF')
    }
    const member = await ctx.db.get(memberId)
    if (!member || member.tenantId !== tc.tenantId) {
      throw new ConvexError('MEMBER_NOT_FOUND')
    }
    await ctx.db.patch(memberId, { canViewNpi })
    await recordAudit(
      ctx,
      tc,
      'member.npi_access_changed',
      'member',
      memberId,
      {
        from: member.canViewNpi,
        to: canViewNpi,
      }
    )
    return { ok: true }
  },
})

// Pending invitations from Better Auth (for the admin members panel).
export const listPendingInvitations = query({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)

    const page = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: 'invitation',
      where: [{ field: 'organizationId', value: tc.betterAuthOrgId }],
      paginationOpts: { numItems: 100, cursor: null },
    })) as {
      page: Array<{
        _id: string
        email: string | null
        role: string | null
        status: string | null
        expiresAt: number | null
        createdAt: number | null
      }>
    }

    return page.page.filter((i) => i.status === 'pending')
  },
})

// ─────────────────────────────────────────────────────────────────────
// Better Auth `databaseHooks.session` helpers
//
// On sign-in, Better Auth calls `session.create.before` — we look up the
// user's most-recently-touched membership and preset its org as the
// session's activeOrganizationId, so returning users land directly on
// their last tenant instead of bouncing through the picker / auto-activate.
//
// On `setActive`, Better Auth calls `session.update.after` — we bump
// `lastLoginAt` on the matching tenantMember, so the next sign-in resolves
// to the same org.
// ─────────────────────────────────────────────────────────────────────

export const lastActiveOrgForUser = internalQuery({
  args: { betterAuthUserId: v.string() },
  handler: async (ctx, { betterAuthUserId }) => {
    const memberships = await ctx.db
      .query('tenantMembers')
      .withIndex('by_betterAuthUser', (q) =>
        q.eq('betterAuthUserId', betterAuthUserId)
      )
      .collect()

    const candidates = memberships.filter((m) => m.status === 'active')
    if (candidates.length === 0) return null

    candidates.sort((a, b) => {
      const aT = a.lastLoginAt ?? a._creationTime
      const bT = b.lastLoginAt ?? b._creationTime
      return bT - aT
    })

    // Walk in recency order — skip memberships whose tenant is no longer
    // active so we never return a stale/suspended org.
    for (const m of candidates) {
      const tenant = await ctx.db.get(m.tenantId)
      if (!tenant) continue
      if (tenant.status !== 'active' && tenant.status !== 'trial') continue
      return tenant.betterAuthOrgId
    }
    return null
  },
})

export const touchLastActiveOrg = internalMutation({
  args: {
    betterAuthUserId: v.string(),
    betterAuthOrgId: v.string(),
  },
  handler: async (ctx, { betterAuthUserId, betterAuthOrgId }) => {
    const tenant = await ctx.db
      .query('tenants')
      .withIndex('by_better_auth_org', (q) =>
        q.eq('betterAuthOrgId', betterAuthOrgId)
      )
      .unique()
    if (!tenant) return

    const member = await ctx.db
      .query('tenantMembers')
      .withIndex('by_betterAuthUser_tenant', (q) =>
        q.eq('betterAuthUserId', betterAuthUserId).eq('tenantId', tenant._id)
      )
      .unique()
    if (!member) return

    await ctx.db.patch(member._id, { lastLoginAt: Date.now() })
  },
})
