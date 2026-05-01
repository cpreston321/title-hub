import { ConvexError, v } from 'convex/values'
import { internalMutation, mutation, query } from './_generated/server'
import { internal } from './_generated/api'
import { requireRole, requireTenant } from './lib/tenant'
import { recordAudit } from './lib/audit'
import { fanOutNotification } from './notifications'
import { autoPromoteFileStatus } from './files'

// Public: schedule a Claude extraction for a document attached to a file.
export const run = mutation({
  args: { documentId: v.id('documents') },
  handler: async (ctx, { documentId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner', 'admin', 'processor')

    const doc = await ctx.db.get(documentId)
    if (!doc || doc.tenantId !== tc.tenantId) {
      throw new ConvexError('DOCUMENT_NOT_FOUND')
    }
    if (!doc.fileId) throw new ConvexError('DOCUMENT_NOT_ATTACHED_TO_FILE')

    // Replace any prior extraction — only the latest run feeds reconciliation.
    const prior = await ctx.db
      .query('documentExtractions')
      .withIndex('by_tenant_document', (q) =>
        q.eq('tenantId', tc.tenantId).eq('documentId', documentId)
      )
      .unique()
    if (prior) await ctx.db.delete(prior._id)

    const extractionId = await ctx.db.insert('documentExtractions', {
      tenantId: tc.tenantId,
      fileId: doc.fileId,
      documentId,
      status: 'pending',
      source: 'claude',
      startedAt: Date.now(),
    })

    await recordAudit(ctx, tc, 'extraction.requested', 'file', doc.fileId, {
      documentId,
      extractionId,
      docType: doc.docType,
    })

    await ctx.scheduler.runAfter(0, internal.extractionsRunner.runJob, {
      extractionId,
      storageId: doc.storageId,
      docTypeHint: doc.docType,
    })

    return { extractionId }
  },
})

export const markRunning = internalMutation({
  args: { extractionId: v.id('documentExtractions') },
  handler: async (ctx, { extractionId }) => {
    const ext = await ctx.db.get(extractionId)
    if (!ext) return
    await ctx.db.patch(extractionId, { status: 'running' })
  },
})

export const markSucceeded = internalMutation({
  args: {
    extractionId: v.id('documentExtractions'),
    payload: v.any(),
    modelId: v.string(),
    source: v.union(v.literal('claude'), v.literal('mock')),
  },
  handler: async (ctx, { extractionId, payload, modelId, source }) => {
    const ext = await ctx.db.get(extractionId)
    if (!ext) return
    await ctx.db.patch(extractionId, {
      status: 'succeeded',
      payload,
      modelId,
      source,
      completedAt: Date.now(),
    })

    // Auto-reconcile: every successful extraction triggers a fresh run so the
    // file's findings always reflect the latest set of extracted facts. If
    // multiple docs land at once they each schedule, but the run is idempotent
    // (wipes existing open findings and re-creates them).
    await ctx.scheduler.runAfter(0, internal.reconciliation.runForFileAuto, {
      tenantId: ext.tenantId,
      fileId: ext.fileId,
    })

    // Lifecycle nudge: opened → in_exam on the first successful extraction.
    // Idempotent — only fires when status is still "opened", so re-extractions
    // and parallel completions don't churn.
    await autoPromoteFileStatus(
      ctx,
      ext.fileId,
      ['opened'],
      'in_exam',
      'extraction_succeeded'
    )

    // Notify the team. Pull doc title + file number for friendly copy.
    const doc = await ctx.db.get(ext.documentId)
    const file = await ctx.db.get(ext.fileId)
    await fanOutNotification(ctx, ext.tenantId, {
      kind: 'extraction.succeeded',
      severity: 'ok',
      title: `Extracted ${doc?.title ?? doc?.docType ?? 'a document'}`,
      body: file ? `On file ${file.fileNumber}` : undefined,
      fileId: ext.fileId,
      actorType: 'system',
    })
  },
})

export const markFailed = internalMutation({
  args: {
    extractionId: v.id('documentExtractions'),
    errorMessage: v.string(),
  },
  handler: async (ctx, { extractionId, errorMessage }) => {
    const ext = await ctx.db.get(extractionId)
    if (!ext) return
    await ctx.db.patch(extractionId, {
      status: 'failed',
      errorMessage,
      completedAt: Date.now(),
    })

    const doc = await ctx.db.get(ext.documentId)
    const file = await ctx.db.get(ext.fileId)
    await fanOutNotification(ctx, ext.tenantId, {
      kind: 'extraction.failed',
      severity: 'warn',
      title: `Extraction failed: ${doc?.title ?? doc?.docType ?? 'document'}`,
      body: file
        ? `On file ${file.fileNumber} — ${errorMessage}`
        : errorMessage,
      fileId: ext.fileId,
      actorType: 'system',
    })
  },
})

export const listForFile = query({
  args: { fileId: v.id('files') },
  handler: async (ctx, { fileId }) => {
    const tc = await requireTenant(ctx)
    return await ctx.db
      .query('documentExtractions')
      .withIndex('by_tenant_file', (q) =>
        q.eq('tenantId', tc.tenantId).eq('fileId', fileId)
      )
      .order('desc')
      .take(50)
  },
})

export const getForDocument = query({
  args: { documentId: v.id('documents') },
  handler: async (ctx, { documentId }) => {
    const tc = await requireTenant(ctx)
    return await ctx.db
      .query('documentExtractions')
      .withIndex('by_tenant_document', (q) =>
        q.eq('tenantId', tc.tenantId).eq('documentId', documentId)
      )
      .unique()
  },
})
