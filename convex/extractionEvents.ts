/**
 * Append-only, per-extraction audit trail.
 *
 * The Anthropic-backed runner posts one row per phase boundary so the file
 * UI can render a live "thinking trail" while a doc is being read, and a
 * permanent timeline after the fact. Distinct from the documentExtractions
 * row (which holds the final payload) so a noisy run doesn't bloat the
 * parent record.
 *
 * Why a separate module: extractionsRunner runs in Node; this file stays in
 * the default V8 runtime so its mutations and queries can co-exist.
 */
import { ConvexError, v } from 'convex/values'
import { internalMutation, query } from './_generated/server'
import { requireTenant } from './lib/tenant'

export const eventKind = v.union(
  v.literal('phase'),
  v.literal('observation'),
  v.literal('warning'),
  v.literal('error'),
  v.literal('done')
)

// Internal-only: called from extractionsRunner.runJob via ctx.runMutation as
// each phase fires. Each call is its own transaction so a long Anthropic
// roundtrip can still emit a "sent_to_model" row before the response lands.
export const append = internalMutation({
  args: {
    extractionId: v.id('documentExtractions'),
    kind: eventKind,
    label: v.string(),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, { extractionId, kind, label, detail }) => {
    const ext = await ctx.db.get(extractionId)
    if (!ext) return null

    // Compute next sequence number from the last event, capped at 200 per
    // extraction. Anything beyond is dropped — keeps a runaway loop from
    // burning a tenant's transaction budget.
    const last = await ctx.db
      .query('extractionEvents')
      .withIndex('by_tenant_extraction_seq', (q) =>
        q.eq('tenantId', ext.tenantId).eq('extractionId', extractionId)
      )
      .order('desc')
      .first()
    const seq = last ? last.seq + 1 : 0
    if (seq > 200) return null

    const id = await ctx.db.insert('extractionEvents', {
      tenantId: ext.tenantId,
      extractionId,
      fileId: ext.fileId,
      documentId: ext.documentId,
      seq,
      kind,
      label,
      detail,
      createdAt: Date.now(),
    })
    return id
  },
})

export const listForExtraction = query({
  args: { extractionId: v.id('documentExtractions') },
  handler: async (ctx, { extractionId }) => {
    const tc = await requireTenant(ctx)
    const ext = await ctx.db.get(extractionId)
    if (!ext || ext.tenantId !== tc.tenantId) {
      throw new ConvexError('EXTRACTION_NOT_FOUND')
    }
    return await ctx.db
      .query('extractionEvents')
      .withIndex('by_tenant_extraction_seq', (q) =>
        q.eq('tenantId', tc.tenantId).eq('extractionId', extractionId)
      )
      .take(200)
  },
})

// File-wide activity rail: every event across every extraction on a file,
// most-recent first. Bounded so a file with hundreds of docs doesn't spike
// the read.
export const listForFile = query({
  args: {
    fileId: v.id('files'),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { fileId, limit }) => {
    const tc = await requireTenant(ctx)
    const cap = Math.min(limit ?? 50, 200)
    return await ctx.db
      .query('extractionEvents')
      .withIndex('by_tenant_file_time', (q) =>
        q.eq('tenantId', tc.tenantId).eq('fileId', fileId)
      )
      .order('desc')
      .take(cap)
  },
})
