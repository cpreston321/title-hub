import { ConvexError } from 'convex/values'
import type { QueryCtx, MutationCtx } from '../_generated/server'
import type { Id } from '../_generated/dataModel'
import { components } from '../_generated/api'

// Resolved auth/tenant context for an authenticated request. Built from:
//   1. ctx.auth.getUserIdentity()  — verified subject (Better Auth user._id)
//   2. component session row       — carries activeOrganizationId
//   3. our app-side tenants row    — joined by betterAuthOrgId
//   4. our app-side tenantMembers  — role + canViewNpi for the current user

export type Role =
  | 'owner'
  | 'admin'
  | 'processor'
  | 'closer'
  | 'reviewer'
  | 'readonly'

export type TenantContext = {
  memberId: Id<'tenantMembers'>
  tenantId: Id<'tenants'>
  betterAuthUserId: string
  betterAuthOrgId: string
  role: Role
  canViewNpi: boolean
}

export async function requireTenant(
  ctx: QueryCtx | MutationCtx
): Promise<TenantContext> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw new ConvexError('UNAUTHENTICATED')
  const betterAuthUserId = identity.subject

  // Look up the session that issued THIS request's JWT, not "any session for
  // the user". The Convex Better Auth plugin puts `sessionId` on the identity
  // (see @convex-dev/better-auth/src/plugins/convex/index.ts) — looking up by
  // userId can return a stale session whose activeOrganizationId hasn't been
  // updated by setActive, which produced an infinite NO_ACTIVE_TENANT loop
  // when a user had more than one session.
  const sessionId = identity.sessionId as string | undefined
  if (!sessionId) throw new ConvexError('UNAUTHENTICATED')
  const session = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: 'session',
    where: [
      { field: '_id', value: sessionId },
      {
        field: 'expiresAt',
        operator: 'gt',
        value: new Date().getTime(),
      },
    ],
  })) as { activeOrganizationId?: string | null } | null

  if (!session?.activeOrganizationId) {
    throw new ConvexError('NO_ACTIVE_TENANT')
  }
  const betterAuthOrgId = session.activeOrganizationId

  const tenant = await ctx.db
    .query('tenants')
    .withIndex('by_better_auth_org', (q) =>
      q.eq('betterAuthOrgId', betterAuthOrgId)
    )
    .unique()
  if (!tenant) throw new ConvexError('TENANT_NOT_FOUND')
  if (tenant.status !== 'active' && tenant.status !== 'trial') {
    throw new ConvexError('TENANT_INACTIVE')
  }

  const member = await ctx.db
    .query('tenantMembers')
    .withIndex('by_betterAuthUser_tenant', (q) =>
      q.eq('betterAuthUserId', betterAuthUserId).eq('tenantId', tenant._id)
    )
    .unique()
  if (!member) throw new ConvexError('NOT_A_MEMBER')
  if (member.status !== 'active') throw new ConvexError('MEMBER_INACTIVE')

  return {
    memberId: member._id,
    tenantId: member.tenantId,
    betterAuthUserId,
    betterAuthOrgId,
    role: member.role,
    canViewNpi: member.canViewNpi,
  }
}

export function requireRole(tc: TenantContext, ...allowed: Role[]) {
  if (!allowed.includes(tc.role)) throw new ConvexError('FORBIDDEN')
}

// Like `requireTenant` but returns `null` instead of throwing when the
// caller is mid-handshake (no JWT yet, no active org on the session, tenant
// row missing, etc.). Use this from queries that are commonly subscribed
// during the auth/active-org dance — like the notifications bell or the
// dashboard's secondary feeds — so they don't pollute the Convex log with
// expected transient `UNAUTHENTICATED` / `NO_ACTIVE_TENANT` errors. Real
// authorization failures (a logged-in user trying to read another tenant's
// data) should still go through `requireTenant`.
export async function optionalTenant(
  ctx: QueryCtx | MutationCtx
): Promise<TenantContext | null> {
  try {
    return await requireTenant(ctx)
  } catch (err) {
    if (err instanceof ConvexError) {
      const msg = String(err.data ?? err.message)
      if (
        msg === 'UNAUTHENTICATED' ||
        msg === 'NO_ACTIVE_TENANT' ||
        msg === 'TENANT_NOT_FOUND' ||
        msg === 'TENANT_INACTIVE' ||
        msg === 'NOT_A_MEMBER' ||
        msg === 'MEMBER_INACTIVE'
      ) {
        return null
      }
    }
    throw err
  }
}

export function requireNpiAccess(tc: TenantContext) {
  if (!tc.canViewNpi) throw new ConvexError('NPI_FORBIDDEN')
}
