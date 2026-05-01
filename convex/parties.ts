import { ConvexError, v } from 'convex/values'
import { mutation } from './_generated/server'
import { requireRole, requireTenant } from './lib/tenant'
import { recordAudit } from './lib/audit'

const editorRoles = ['owner', 'admin', 'processor'] as const

export const setSecretToken = mutation({
  args: {
    partyId: v.id('parties'),
    token: v.string(),
  },
  handler: async (ctx, { partyId, token }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)

    const party = await ctx.db.get(partyId)
    if (!party || party.tenantId !== tc.tenantId) {
      throw new ConvexError('PARTY_NOT_FOUND')
    }

    // Sanity: token must belong to this tenant.
    const secret = await ctx.db
      .query('npiSecrets')
      .withIndex('by_tenant_token', (q) =>
        q.eq('tenantId', tc.tenantId).eq('token', token)
      )
      .unique()
    if (!secret) throw new ConvexError('TOKEN_NOT_FOUND')

    await ctx.db.patch(partyId, { einOrSsnToken: token })
    await recordAudit(ctx, tc, 'party.npi_attached', 'party', partyId, {
      tokenPrefix: token.slice(0, 12),
      fieldKind: secret.fieldKind,
    })
    return { ok: true }
  },
})
