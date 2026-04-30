import type { MutationCtx } from "../_generated/server"
import type { TenantContext } from "./tenant"

export type ActorType = "user" | "api_key" | "system" | "webhook"

export async function recordAudit(
  ctx: MutationCtx,
  tc: TenantContext,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown> = {},
  actorType: ActorType = "user",
) {
  await ctx.db.insert("auditEvents", {
    tenantId: tc.tenantId,
    actorMemberId: tc.memberId,
    actorType,
    action,
    resourceType,
    resourceId,
    metadata,
    occurredAt: Date.now(),
  })
}
