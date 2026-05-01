import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import type { QueryCtx } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import { requireRole, requireTenant } from './lib/tenant'
import { recordAudit } from './lib/audit'

// Order management = the triage queue for files that have just been opened
// (manual or via integration sync) and are pre-clearance. The Files register
// is the full lifecycle; this view is intentionally narrow: just `opened`
// and `in_exam`, with the signals a processor needs to decide what to work
// on next.

const editorRoles = ['owner', 'admin', 'processor'] as const

type OrderSource = 'manual' | 'softpro' | 'qualia' | 'resware'

function deriveSource(file: Doc<'files'>): OrderSource {
  const ext = file.externalRefs
  if (ext?.softproId) return 'softpro'
  if (ext?.qualiaId) return 'qualia'
  if (ext?.reswareId) return 'resware'
  return 'manual'
}

async function listTriageFiles(
  ctx: QueryCtx,
  tenantId: Id<'tenants'>,
  cap: number
): Promise<Array<Doc<'files'>>> {
  // `by_tenant_status` only lets us filter on a single status at a time, and
  // we want both. Two narrow scans + merge beats `by_tenant_openedAt` + a
  // status filter once the tenant has any meaningful number of closed files.
  const [opened, inExam] = await Promise.all([
    ctx.db
      .query('files')
      .withIndex('by_tenant_status', (q) =>
        q.eq('tenantId', tenantId).eq('status', 'opened')
      )
      .order('desc')
      .take(cap),
    ctx.db
      .query('files')
      .withIndex('by_tenant_status', (q) =>
        q.eq('tenantId', tenantId).eq('status', 'in_exam')
      )
      .order('desc')
      .take(cap),
  ])
  return [...opened, ...inExam]
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, cap)
}

export const list = query({
  args: {
    source: v.optional(
      v.union(
        v.literal('manual'),
        v.literal('softpro'),
        v.literal('qualia'),
        v.literal('resware')
      )
    ),
    status: v.optional(
      v.union(v.literal('opened'), v.literal('in_exam'))
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { source, status, limit }) => {
    const tc = await requireTenant(ctx)
    const cap = Math.min(limit ?? 50, 100)

    const files = await listTriageFiles(ctx, tc.tenantId, cap)
    const filtered = files.filter((f) => {
      if (status && f.status !== status) return false
      if (source && deriveSource(f) !== source) return false
      return true
    })

    const enriched = await Promise.all(
      filtered.map(async (file) => {
        const [county, fileParties, documents, extractions, findings] =
          await Promise.all([
            ctx.db.get(file.countyId),
            ctx.db
              .query('fileParties')
              .withIndex('by_tenant_file', (q) =>
                q.eq('tenantId', tc.tenantId).eq('fileId', file._id)
              )
              .collect(),
            ctx.db
              .query('documents')
              .withIndex('by_tenant_file', (q) =>
                q.eq('tenantId', tc.tenantId).eq('fileId', file._id)
              )
              .collect(),
            ctx.db
              .query('documentExtractions')
              .withIndex('by_tenant_file', (q) =>
                q.eq('tenantId', tc.tenantId).eq('fileId', file._id)
              )
              .collect(),
            ctx.db
              .query('reconciliationFindings')
              .withIndex('by_tenant_file_status', (q) =>
                q
                  .eq('tenantId', tc.tenantId)
                  .eq('fileId', file._id)
                  .eq('status', 'open')
              )
              .collect(),
          ])

        const extractionCounts = {
          pending: 0,
          running: 0,
          succeeded: 0,
          failed: 0,
        }
        for (const e of extractions) extractionCounts[e.status]++

        const findingCounts = { block: 0, warn: 0, info: 0 }
        for (const f of findings) findingCounts[f.severity]++

        return {
          _id: file._id,
          fileNumber: file.fileNumber,
          status: file.status,
          stateCode: file.stateCode,
          countyName: county?.name ?? null,
          transactionType: file.transactionType,
          propertyAddress: file.propertyAddress ?? null,
          propertyApn: file.propertyApn ?? null,
          openedAt: file.openedAt,
          targetCloseDate: file.targetCloseDate ?? null,
          source: deriveSource(file),
          externalId:
            file.externalRefs?.softproId ??
            file.externalRefs?.qualiaId ??
            file.externalRefs?.reswareId ??
            null,
          partyCount: fileParties.length,
          documentCount: documents.length,
          extractionCounts,
          findingCounts,
          findingTotal: findings.length,
        }
      })
    )

    return enriched
  },
})

export const summary = query({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)

    // Pull both buckets — same access pattern as `list` so we stay in cache.
    const files = await listTriageFiles(ctx, tc.tenantId, 200)

    const bySource: Record<OrderSource, number> = {
      manual: 0,
      softpro: 0,
      qualia: 0,
      resware: 0,
    }
    const byStatus = { opened: 0, in_exam: 0 }
    let staleCount = 0
    let withoutPartiesCount = 0
    const sevenDaysMs = 7 * 24 * 3600 * 1000

    // Per-file flags for the "needs attention" tile; one extra parties read
    // per file is acceptable at the cap of 200.
    for (const file of files) {
      bySource[deriveSource(file)]++
      if (file.status === 'opened') byStatus.opened++
      else if (file.status === 'in_exam') byStatus.in_exam++

      if (Date.now() - file.openedAt > sevenDaysMs) staleCount++

      const parties = await ctx.db
        .query('fileParties')
        .withIndex('by_tenant_file', (q) =>
          q.eq('tenantId', tc.tenantId).eq('fileId', file._id)
        )
        .take(1)
      if (parties.length === 0) withoutPartiesCount++
    }

    return {
      total: files.length,
      bySource,
      byStatus,
      staleCount,
      withoutPartiesCount,
    }
  },
})

export const advanceToExam = mutation({
  args: { fileId: v.id('files') },
  handler: async (ctx, { fileId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)

    const file = await ctx.db.get(fileId)
    if (!file || file.tenantId !== tc.tenantId) {
      throw new ConvexError('FILE_NOT_FOUND')
    }
    if (file.status !== 'opened') {
      throw new ConvexError('INVALID_STATUS_TRANSITION')
    }

    await ctx.db.patch(fileId, { status: 'in_exam' })
    await recordAudit(ctx, tc, 'file.status_changed', 'file', fileId, {
      from: 'opened',
      to: 'in_exam',
      via: 'order_management',
    })
    return { ok: true }
  },
})

export const cancel = mutation({
  args: { fileId: v.id('files'), reason: v.optional(v.string()) },
  handler: async (ctx, { fileId, reason }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)

    const file = await ctx.db.get(fileId)
    if (!file || file.tenantId !== tc.tenantId) {
      throw new ConvexError('FILE_NOT_FOUND')
    }
    if (file.status === 'cancelled' || file.status === 'policied') {
      throw new ConvexError('INVALID_STATUS_TRANSITION')
    }

    await ctx.db.patch(fileId, { status: 'cancelled' })
    await recordAudit(ctx, tc, 'file.status_changed', 'file', fileId, {
      from: file.status,
      to: 'cancelled',
      via: 'order_management',
      reason: reason ?? null,
    })
    return { ok: true }
  },
})
