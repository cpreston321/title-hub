import { v } from 'convex/values'
import { internalMutation, query } from './_generated/server'
import type { QueryCtx } from './_generated/server'
import type { TenantContext } from './lib/tenant'
import { requireTenant } from './lib/tenant'
import { buildDocumentSearchText, buildFileSearchText } from './files'

const MAX_Q = 80
const PER_GROUP = 5

async function tenantOrNull(ctx: QueryCtx): Promise<TenantContext | null> {
  try {
    return await requireTenant(ctx)
  } catch {
    return null
  }
}

export const global = query({
  args: { q: v.string() },
  handler: async (ctx, { q }) => {
    const empty = {
      files: [],
      parties: [],
      findings: [],
      documents: [],
      emails: [],
    }
    const trimmed = q.trim().slice(0, MAX_Q)
    if (trimmed.length < 2) return empty

    const tc = await tenantOrNull(ctx)
    if (!tc) return empty

    const [
      fileMatches,
      partyMatches,
      findingMatches,
      documentMatches,
      emailMatches,
    ] = await Promise.all([
      ctx.db
        .query('files')
        .withSearchIndex('search_text', (s) =>
          s.search('searchText', trimmed).eq('tenantId', tc.tenantId)
        )
        .take(PER_GROUP),
      ctx.db
        .query('parties')
        .withSearchIndex('search_legalname', (s) =>
          s.search('legalName', trimmed).eq('tenantId', tc.tenantId)
        )
        .take(PER_GROUP),
      ctx.db
        .query('reconciliationFindings')
        .withSearchIndex('search_message', (s) =>
          s.search('message', trimmed).eq('tenantId', tc.tenantId)
        )
        .take(PER_GROUP),
      ctx.db
        .query('documents')
        .withSearchIndex('search_text', (s) =>
          s.search('searchText', trimmed).eq('tenantId', tc.tenantId)
        )
        .take(PER_GROUP),
      ctx.db
        .query('inboundEmails')
        .withSearchIndex('search_subject', (s) =>
          s.search('subject', trimmed).eq('tenantId', tc.tenantId)
        )
        .take(PER_GROUP),
    ])

    const parties = await Promise.all(
      partyMatches.map(async (p) => {
        const fp = await ctx.db
          .query('fileParties')
          .withIndex('by_tenant_party', (qb) =>
            qb.eq('tenantId', tc.tenantId).eq('partyId', p._id)
          )
          .first()
        const file = fp ? await ctx.db.get(fp.fileId) : null
        return {
          partyId: p._id,
          legalName: p.legalName,
          partyType: p.partyType,
          fileId: file?._id ?? null,
          fileNumber: file?.fileNumber ?? null,
        }
      })
    )

    const findings = await Promise.all(
      findingMatches.map(async (f) => {
        const file = await ctx.db.get(f.fileId)
        return {
          findingId: f._id,
          fileId: f.fileId,
          fileNumber: file?.fileNumber ?? null,
          severity: f.severity,
          findingType: f.findingType,
          message: f.message,
          status: f.status,
        }
      })
    )

    const documents = await Promise.all(
      documentMatches.map(async (d) => {
        const file = d.fileId ? await ctx.db.get(d.fileId) : null
        return {
          documentId: d._id,
          fileId: d.fileId ?? null,
          fileNumber: file?.fileNumber ?? null,
          title: d.title ?? null,
          docType: d.docType,
          uploadedAt: d.uploadedAt,
        }
      })
    )

    const emails = emailMatches.map((e) => ({
      inboundEmailId: e._id,
      subject: e.subject,
      fromAddress: e.fromAddress,
      fromName: e.fromName ?? null,
      receivedAt: e.receivedAt,
      status: e.status,
      matchedFileId: e.matchedFileId ?? null,
      classificationIntent: e.classification?.intent ?? null,
    }))

    return {
      files: fileMatches.map((f) => ({
        _id: f._id,
        fileNumber: f.fileNumber,
        transactionType: f.transactionType,
        status: f.status,
      })),
      parties,
      findings,
      documents,
      emails,
    }
  },
})

// One-shot recompute of `files.searchText` across every row. Run via
// `npx convex run search:backfillFileSearchText` after deploying the new
// `search_text` index, or any time the searchable shape changes. Idempotent —
// only patches rows whose computed value differs from what's stored.
export const backfillFileSearchText = internalMutation({
  args: {},
  handler: async (ctx) => {
    const files = await ctx.db.query('files').collect()
    const countyCache = new Map<string, string>()
    let updated = 0
    for (const f of files) {
      let countyName = countyCache.get(f.countyId)
      if (countyName === undefined) {
        const county = await ctx.db.get(f.countyId)
        countyName = county?.name ?? ''
        countyCache.set(f.countyId, countyName)
      }
      const next = buildFileSearchText(f, countyName || null)
      if (f.searchText !== next) {
        await ctx.db.patch(f._id, { searchText: next })
        updated++
      }
    }
    return { scanned: files.length, updated }
  },
})

// Same idea for documents.searchText. Run once after deploying the
// search_text index. Cheap because the formula is title + docType.
export const backfillDocumentSearchText = internalMutation({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query('documents').collect()
    let updated = 0
    for (const d of docs) {
      const next = buildDocumentSearchText({
        title: d.title ?? undefined,
        docType: d.docType,
      })
      if (d.searchText !== next) {
        await ctx.db.patch(d._id, { searchText: next })
        updated++
      }
    }
    return { scanned: docs.length, updated }
  },
})
