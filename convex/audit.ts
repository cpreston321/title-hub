import { v } from 'convex/values'
import { query } from './_generated/server'
import { components } from './_generated/api'
import { requireTenant } from './lib/tenant'
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

    return await enrichWithActor(ctx, events)
  },
})

export const listForTenant = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const tc = await requireTenant(ctx)
    const cap = Math.min(limit ?? 100, 500)

    const events = await ctx.db
      .query('auditEvents')
      .withIndex('by_tenant_time', (q) => q.eq('tenantId', tc.tenantId))
      .order('desc')
      .take(cap)

    return await enrichWithActor(ctx, events)
  },
})

async function enrichWithActor(
  ctx: { db: any; runQuery: any },
  events: ReadonlyArray<Doc<'auditEvents'>>
) {
  // Cache member + auth-user lookups so the same actor isn't hit repeatedly.
  const memberCache = new Map<
    string,
    { email: string; name: string | null; role: string } | null
  >()

  const out: Array<Doc<'auditEvents'> & { actor: ActorInfo }> = []
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

    out.push({ ...e, actor })
  }
  return out
}
