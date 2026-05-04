import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import type { MutationCtx, QueryCtx } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import { internal } from './_generated/api'
import { optionalTenant, requireRole, requireTenant } from './lib/tenant'
import { recordAudit } from './lib/audit'
import { fileStatus, partyType, propertyAddress } from './schema'
import {
  boundaryFor,
  formatFileNumber,
  type Cadence,
} from './lib/fileNumber'

const editorRoles = ['owner', 'admin', 'processor'] as const

// Denormalized blob for the documents.search_text index. Reads filename +
// docType so a search for "wire" or "purchase agreement" surfaces docs
// without us indexing every byte of OCR.
export function buildDocumentSearchText(doc: {
  title?: string
  docType: string
}): string {
  return [doc.title, doc.docType.replace(/_/g, ' ')]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ')
}

export function buildFileSearchText(
  file: {
    fileNumber: string
    transactionType: string
    propertyApn?: string
    propertyAddress?: {
      line1: string
      line2?: string
      city: string
      state: string
      zip: string
    }
  },
  countyName?: string | null
): string {
  const addr = file.propertyAddress
  return [
    file.fileNumber,
    file.transactionType,
    file.propertyApn,
    addr?.line1,
    addr?.line2,
    addr?.city,
    addr?.state,
    addr?.zip,
    countyName,
  ]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ')
}

async function loadFile(
  ctx: QueryCtx,
  fileId: Id<'files'>,
  tenantId: Id<'tenants'>
): Promise<Doc<'files'>> {
  const file = await ctx.db.get(fileId)
  if (!file) throw new ConvexError('FILE_NOT_FOUND')
  if (file.tenantId !== tenantId) throw new ConvexError('FILE_NOT_FOUND')
  return file
}

// Idempotent system-driven status advance. Patches the file only when its
// current status is one of `from`; otherwise no-op so concurrent triggers and
// re-runs (e.g. multiple extractions completing) don't fight each other or
// undo a manual move the user has already made.
export async function autoPromoteFileStatus(
  ctx: MutationCtx,
  fileId: Id<'files'>,
  from: ReadonlyArray<Doc<'files'>['status']>,
  to: Doc<'files'>['status'],
  reason: string
): Promise<boolean> {
  const file = await ctx.db.get(fileId)
  if (!file) return false
  if (file.status === to) return false
  if (!from.includes(file.status)) return false
  await ctx.db.patch(fileId, { status: to })
  await ctx.db.insert('auditEvents', {
    tenantId: file.tenantId,
    actorType: 'system',
    action: 'file.status_changed',
    resourceType: 'file',
    resourceId: fileId,
    metadata: { from: file.status, to, reason, auto: true },
    occurredAt: Date.now(),
  })
  return true
}

export const create = mutation({
  args: {
    // Empty string ⇒ generate from the tenant's file-number policy.
    // A non-empty value uses the caller's chosen number verbatim.
    fileNumber: v.string(),
    countyId: v.id('counties'),
    transactionType: v.string(),
    propertyAddress: v.optional(propertyAddress),
    propertyApn: v.optional(v.string()),
    targetCloseDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)

    const county = await ctx.db.get(args.countyId)
    if (!county) throw new ConvexError('COUNTY_NOT_FOUND')

    let fileNumber = args.fileNumber.trim()
    let autoAssigned = false

    if (fileNumber === '') {
      // Caller wants the server to allocate. Pull the policy, format,
      // bump the counter atomically. If a generated number happens to
      // collide (rare — e.g. a manual entry took the slot before us),
      // try the next few seq values before giving up.
      const policyRow = await ctx.db
        .query('tenantFileNumberPolicy')
        .withIndex('by_tenant', (q) => q.eq('tenantId', tc.tenantId))
        .unique()
      if (!policyRow) {
        // Tenant hasn't configured auto-numbering — keep the legacy
        // contract: fileNumber is required.
        throw new ConvexError('INVALID_FILE_NUMBER')
      }

      const date = new Date()
      const cadence = policyRow.seqResetCadence as Cadence
      const currentBoundary = boundaryFor(date, cadence)
      const startSeq =
        currentBoundary !== policyRow.seqLastResetBoundary
          ? 1
          : policyRow.nextSeq

      const countyCode = county.name.replace(/\s+/g, '').toUpperCase()
      const formatCtx = {
        date,
        countyCode,
        stateCode: county.stateCode,
        transactionType: args.transactionType,
      }

      let chosen: { number: string; seq: number } | null = null
      for (let offset = 0; offset < 20 && chosen === null; offset++) {
        const seq = startSeq + offset
        const candidate = formatFileNumber(policyRow.pattern, {
          ...formatCtx,
          seq,
        })
        const existing = await ctx.db
          .query('files')
          .withIndex('by_tenant_filenumber', (q) =>
            q.eq('tenantId', tc.tenantId).eq('fileNumber', candidate)
          )
          .unique()
        if (!existing) chosen = { number: candidate, seq }
      }
      if (!chosen) {
        throw new ConvexError({
          kind: 'FILE_NUMBER_EXHAUSTED',
          message:
            'Could not allocate a unique file number after 20 attempts. Bump the counter or change the pattern.',
        })
      }
      fileNumber = chosen.number
      autoAssigned = true

      // Advance the counter past the chosen seq. We don't reuse the
      // skipped numbers — gaps are fine; what matters is monotonicity.
      await ctx.db.patch(policyRow._id, {
        nextSeq: chosen.seq + 1,
        seqLastResetBoundary: currentBoundary,
      })
    } else {
      const dup = await ctx.db
        .query('files')
        .withIndex('by_tenant_filenumber', (q) =>
          q.eq('tenantId', tc.tenantId).eq('fileNumber', fileNumber)
        )
        .unique()
      if (dup) throw new ConvexError('FILE_NUMBER_TAKEN')
    }

    const searchText = buildFileSearchText(
      {
        fileNumber,
        transactionType: args.transactionType,
        propertyApn: args.propertyApn,
        propertyAddress: args.propertyAddress,
      },
      county.name
    )

    const fileId = await ctx.db.insert('files', {
      tenantId: tc.tenantId,
      fileNumber,
      stateCode: county.stateCode,
      countyId: args.countyId,
      transactionType: args.transactionType,
      status: 'opened',
      propertyAddress: args.propertyAddress,
      propertyApn: args.propertyApn,
      searchText,
      openedAt: Date.now(),
      targetCloseDate: args.targetCloseDate,
    })

    await recordAudit(ctx, tc, 'file.created', 'file', fileId, {
      fileNumber,
      countyId: args.countyId,
      autoAssigned,
    })

    return { fileId, fileNumber, autoAssigned }
  },
})

export const get = query({
  args: { fileId: v.id('files') },
  handler: async (ctx, { fileId }) => {
    const tc = await requireTenant(ctx)
    const file = await loadFile(ctx, fileId, tc.tenantId)

    const county = await ctx.db.get(file.countyId)

    const fileParties = await ctx.db
      .query('fileParties')
      .withIndex('by_tenant_file', (q) =>
        q.eq('tenantId', tc.tenantId).eq('fileId', fileId)
      )
      .take(50)

    const parties = await Promise.all(
      fileParties.map(async (fp) => {
        const p = await ctx.db.get(fp.partyId)
        return p
          ? {
              fileParty: fp,
              party: p,
            }
          : null
      })
    )

    const documents = await ctx.db
      .query('documents')
      .withIndex('by_tenant_file', (q) =>
        q.eq('tenantId', tc.tenantId).eq('fileId', fileId)
      )
      .order('desc')
      .take(50)

    return {
      file,
      county,
      parties: parties.filter((p): p is NonNullable<typeof p> => !!p),
      documents,
    }
  },
})

export const list = query({
  args: {
    status: v.optional(fileStatus),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { status, limit }) => {
    // Used by the dashboard + Files register, both of which subscribe before
    // tenant-resolution finishes on first login. Return [] during the
    // transient phase so the Convex log isn't flooded.
    const tc = await optionalTenant(ctx)
    if (!tc) return []
    const cap = Math.min(limit ?? 100, 200)

    const rows = status
      ? await ctx.db
          .query('files')
          .withIndex('by_tenant_status', (q) =>
            q.eq('tenantId', tc.tenantId).eq('status', status)
          )
          .order('desc')
          .take(cap)
      : await ctx.db
          .query('files')
          .withIndex('by_tenant_openedAt', (q) => q.eq('tenantId', tc.tenantId))
          .order('desc')
          .take(cap)

    return rows
  },
})

export const setStatus = mutation({
  args: { fileId: v.id('files'), status: fileStatus },
  handler: async (ctx, { fileId, status }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    const file = await loadFile(ctx, fileId, tc.tenantId)

    await ctx.db.patch(fileId, { status })
    await recordAudit(ctx, tc, 'file.status_changed', 'file', fileId, {
      from: file.status,
      to: status,
    })
    return { ok: true }
  },
})

export const update = mutation({
  args: {
    fileId: v.id('files'),
    transactionType: v.optional(v.string()),
    propertyApn: v.optional(v.string()),
    propertyAddress: v.optional(propertyAddress),
    targetCloseDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    const file = await loadFile(ctx, args.fileId, tc.tenantId)

    const patch: {
      transactionType?: string
      propertyApn?: string
      propertyAddress?: typeof args.propertyAddress
      targetCloseDate?: number
      searchText?: string
    } = {}
    if (args.transactionType !== undefined)
      patch.transactionType = args.transactionType
    if (args.propertyApn !== undefined) patch.propertyApn = args.propertyApn
    if (args.propertyAddress !== undefined)
      patch.propertyAddress = args.propertyAddress
    if (args.targetCloseDate !== undefined)
      patch.targetCloseDate = args.targetCloseDate

    const searchableChanged =
      patch.transactionType !== undefined ||
      patch.propertyApn !== undefined ||
      patch.propertyAddress !== undefined
    if (searchableChanged) {
      const county = await ctx.db.get(file.countyId)
      patch.searchText = buildFileSearchText(
        {
          fileNumber: file.fileNumber,
          transactionType: patch.transactionType ?? file.transactionType,
          propertyApn:
            patch.propertyApn !== undefined
              ? patch.propertyApn
              : file.propertyApn,
          propertyAddress:
            patch.propertyAddress !== undefined
              ? patch.propertyAddress
              : file.propertyAddress,
        },
        county?.name ?? null
      )
    }

    await ctx.db.patch(args.fileId, patch)
    await recordAudit(ctx, tc, 'file.updated', 'file', args.fileId, {
      fields: Object.keys(patch).filter((k) => k !== 'searchText'),
    })

    // Fan out so reconciliation reflects the new file fields. Only an
    // address change triggers a County Connect refetch — APN and
    // transactionType don't drive ATTOM lookups, so they stay in the
    // cheaper "field_changed" bucket (reconcile only).
    const addressChanged = patch.propertyAddress !== undefined
    const otherDownstreamChanged =
      patch.propertyApn !== undefined || patch.transactionType !== undefined
    if (addressChanged || otherDownstreamChanged) {
      await ctx.scheduler.runAfter(0, internal.pipeline.onFileChange, {
        tenantId: tc.tenantId,
        fileId: args.fileId,
        reason: addressChanged ? 'file_address_changed' : 'file_field_changed',
      })
    }
    return { ok: true }
  },
})

export const addParty = mutation({
  args: {
    fileId: v.id('files'),
    partyType: partyType,
    legalName: v.string(),
    role: v.string(),
    capacity: v.optional(v.string()),
    ownershipPct: v.optional(v.number()),
    dba: v.optional(v.string()),
    formationState: v.optional(v.string()),
    entitySubtype: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    await loadFile(ctx, args.fileId, tc.tenantId)

    if (args.legalName.trim() === '')
      throw new ConvexError('INVALID_LEGAL_NAME')

    const partyId = await ctx.db.insert('parties', {
      tenantId: tc.tenantId,
      partyType: args.partyType,
      legalName: args.legalName.trim(),
      dba: args.dba,
      formationState: args.formationState,
      entitySubtype: args.entitySubtype,
    })

    const filePartyId = await ctx.db.insert('fileParties', {
      tenantId: tc.tenantId,
      fileId: args.fileId,
      partyId,
      role: args.role,
      capacity: args.capacity,
      ownershipPct: args.ownershipPct,
    })

    await recordAudit(ctx, tc, 'file.party_added', 'file', args.fileId, {
      partyId,
      filePartyId,
      role: args.role,
      legalName: args.legalName,
    })

    await ctx.scheduler.runAfter(0, internal.pipeline.onFileChange, {
      tenantId: tc.tenantId,
      fileId: args.fileId,
      reason: 'party_changed',
    })

    return { partyId, filePartyId }
  },
})

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    return await ctx.storage.generateUploadUrl()
  },
})

export const recordDocument = mutation({
  args: {
    fileId: v.optional(v.id('files')),
    storageId: v.id('_storage'),
    docType: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, { fileId, storageId, docType, title }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    if (fileId) await loadFile(ctx, fileId, tc.tenantId)

    const meta = await ctx.db.system.get(storageId)
    if (!meta) throw new ConvexError('STORAGE_NOT_FOUND')

    const docId = await ctx.db.insert('documents', {
      tenantId: tc.tenantId,
      fileId,
      docType,
      title,
      searchText: buildDocumentSearchText({ title, docType }),
      storageId,
      contentType: meta.contentType,
      sizeBytes: meta.size,
      checksum: meta.sha256,
      uploadedByMemberId: tc.memberId,
      uploadedAt: Date.now(),
    })

    // Audit under the file when one is attached so the event shows up in the
    // file's activity feed; otherwise log against the document itself.
    if (fileId) {
      await recordAudit(ctx, tc, 'document.uploaded', 'file', fileId, {
        documentId: docId,
        docType,
        sizeBytes: meta.size,
      })
    } else {
      await recordAudit(ctx, tc, 'document.uploaded', 'document', docId, {
        docType,
        sizeBytes: meta.size,
      })
    }

    // Auto-extract: as soon as the document is recorded against a file, kick
    // off Claude extraction. Reconciliation needs an extraction per doc, so
    // doing it implicitly removes a manual step from the workflow.
    let extractionId: Id<'documentExtractions'> | null = null
    if (fileId) {
      extractionId = await scheduleExtractionFor(ctx, tc.tenantId, {
        documentId: docId,
        fileId,
        storageId,
        docType,
      })
      await recordAudit(ctx, tc, 'extraction.requested', 'file', fileId, {
        documentId: docId,
        extractionId,
        docType,
        source: 'auto',
      })
    }

    return { docId, extractionId }
  },
})

// Cascade-delete a document: its extractions, the storage blob, and the row.
// Caller must verify tenant + role before invoking.
export async function deleteDocumentCascade(
  ctx: MutationCtx,
  tenantId: Id<'tenants'>,
  doc: Doc<'documents'>
) {
  const extractions = await ctx.db
    .query('documentExtractions')
    .withIndex('by_tenant_document', (q) =>
      q.eq('tenantId', tenantId).eq('documentId', doc._id)
    )
    .collect()
  for (const e of extractions) await ctx.db.delete(e._id)

  // Best-effort delete of the storage blob; the row goes regardless so an
  // already-cleaned-up blob doesn't leave a phantom document behind.
  try {
    await ctx.storage.delete(doc.storageId)
  } catch {
    // ignore
  }

  // If this document came in via an inbound email, scrub the dangling id
  // out of attachmentDocumentIds. If the email's last attachment goes,
  // bounce the status back to quarantined so the triage UI shows it again
  // and the user can re-route. matchedFileId stays as a soft suggestion so
  // the FilePicker preselects the prior match.
  const emailsReferencing = await ctx.db
    .query('inboundEmails')
    .withIndex('by_tenant_received', (q) => q.eq('tenantId', tenantId))
    .order('desc')
    .take(200)
  let downgraded = 0
  for (const e of emailsReferencing) {
    if (!e.attachmentDocumentIds.includes(doc._id)) continue
    const remaining = e.attachmentDocumentIds.filter((id) => id !== doc._id)
    const patch: Partial<Doc<'inboundEmails'>> = {
      attachmentDocumentIds: remaining,
    }
    if (
      remaining.length === 0 &&
      e.status === 'auto_attached'
    ) {
      patch.status = 'quarantined'
      downgraded++
    }
    await ctx.db.patch(e._id, patch)
  }

  await ctx.db.delete(doc._id)
  return {
    extractionsRemoved: extractions.length,
    inboundEmailsDowngraded: downgraded,
  }
}

// Insert (or replace) a pending extraction row and schedule the runner.
// Used by both the public upload flow and the CLI seed.
export async function scheduleExtractionFor(
  ctx: MutationCtx,
  tenantId: Id<'tenants'>,
  args: {
    documentId: Id<'documents'>
    fileId: Id<'files'>
    storageId: Id<'_storage'>
    docType: string
  }
): Promise<Id<'documentExtractions'>> {
  const prior = await ctx.db
    .query('documentExtractions')
    .withIndex('by_tenant_document', (q) =>
      q.eq('tenantId', tenantId).eq('documentId', args.documentId)
    )
    .unique()
  if (prior) await ctx.db.delete(prior._id)

  const extractionId = await ctx.db.insert('documentExtractions', {
    tenantId,
    fileId: args.fileId,
    documentId: args.documentId,
    status: 'pending',
    source: 'claude',
    startedAt: Date.now(),
  })

  await ctx.scheduler.runAfter(0, internal.extractionsRunner.runJob, {
    extractionId,
    storageId: args.storageId,
    docTypeHint: args.docType,
  })

  return extractionId
}

export const deleteDocument = mutation({
  args: { documentId: v.id('documents') },
  handler: async (ctx, { documentId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)

    const doc = await ctx.db.get(documentId)
    if (!doc || doc.tenantId !== tc.tenantId) {
      throw new ConvexError('DOCUMENT_NOT_FOUND')
    }

    const meta = {
      docType: doc.docType,
      title: doc.title,
      sizeBytes: doc.sizeBytes,
    }

    const result = await deleteDocumentCascade(ctx, tc.tenantId, doc)

    // Audit on the file when there is one so it shows up in the activity feed.
    if (doc.fileId) {
      await recordAudit(ctx, tc, 'document.deleted', 'file', doc.fileId, {
        documentId,
        ...meta,
        extractionsRemoved: result.extractionsRemoved,
      })
    } else {
      await recordAudit(ctx, tc, 'document.deleted', 'document', documentId, {
        ...meta,
        extractionsRemoved: result.extractionsRemoved,
      })
    }

    return { ok: true, extractionsRemoved: result.extractionsRemoved }
  },
})

export const documentUrl = query({
  args: { documentId: v.id('documents') },
  handler: async (ctx, { documentId }) => {
    const tc = await requireTenant(ctx)
    const doc = await ctx.db.get(documentId)
    if (!doc || doc.tenantId !== tc.tenantId) {
      throw new ConvexError('DOCUMENT_NOT_FOUND')
    }
    return await ctx.storage.getUrl(doc.storageId)
  },
})
