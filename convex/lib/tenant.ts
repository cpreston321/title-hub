import { ConvexError } from "convex/values"
import type { QueryCtx, MutationCtx } from "../_generated/server"
import type { Id } from "../_generated/dataModel"
import { authComponent } from "../auth"

export type Role =
  | "owner"
  | "admin"
  | "processor"
  | "closer"
  | "reviewer"
  | "readonly"

export type TenantContext = {
  memberId: Id<"tenantMembers">
  tenantId: Id<"tenants">
  betterAuthUserId: string
  role: Role
  canViewNpi: boolean
}

export async function requireTenant(
  ctx: QueryCtx | MutationCtx,
): Promise<TenantContext> {
  const authUser = await authComponent.getAuthUser(ctx)
  const betterAuthUserId = authUser._id

  const prefs = await ctx.db
    .query("userPreferences")
    .withIndex("by_betterAuthUser", (q) =>
      q.eq("betterAuthUserId", betterAuthUserId),
    )
    .unique()

  if (!prefs?.activeTenantId) {
    throw new ConvexError("NO_ACTIVE_TENANT")
  }

  const member = await ctx.db
    .query("tenantMembers")
    .withIndex("by_betterAuthUser_tenant", (q) =>
      q
        .eq("betterAuthUserId", betterAuthUserId)
        .eq("tenantId", prefs.activeTenantId!),
    )
    .unique()

  if (!member) throw new ConvexError("NOT_A_MEMBER")
  if (member.status !== "active") throw new ConvexError("MEMBER_INACTIVE")

  const tenant = await ctx.db.get(member.tenantId)
  if (!tenant) throw new ConvexError("TENANT_NOT_FOUND")
  if (tenant.status !== "active" && tenant.status !== "trial") {
    throw new ConvexError("TENANT_INACTIVE")
  }

  return {
    memberId: member._id,
    tenantId: member.tenantId,
    betterAuthUserId,
    role: member.role,
    canViewNpi: member.canViewNpi,
  }
}

export function requireRole(tc: TenantContext, ...allowed: Role[]) {
  if (!allowed.includes(tc.role)) throw new ConvexError("FORBIDDEN")
}

export function requireNpiAccess(tc: TenantContext) {
  if (!tc.canViewNpi) throw new ConvexError("NPI_FORBIDDEN")
}
