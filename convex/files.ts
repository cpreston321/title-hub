import { ConvexError, v } from "convex/values"
import { mutation, query } from "./_generated/server"
import type { MutationCtx, QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { internal } from "./_generated/api"
import { requireRole, requireTenant } from "./lib/tenant"
import { recordAudit } from "./lib/audit"
import { fileStatus, partyType, propertyAddress } from "./schema"

const editorRoles = ["owner", "admin", "processor"] as const

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
  countyName?: string | null,
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
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ")
}

async function loadFile(
  ctx: QueryCtx,
  fileId: Id<"files">,
  tenantId: Id<"tenants">,
): Promise<Doc<"files">> {
  const file = await ctx.db.get(fileId)
  if (!file) throw new ConvexError("FILE_NOT_FOUND")
  if (file.tenantId !== tenantId) throw new ConvexError("FILE_NOT_FOUND")
  return file
}

export const create = mutation({
  args: {
    fileNumber: v.string(),
    countyId: v.id("counties"),
    transactionType: v.string(),
    propertyAddress: v.optional(propertyAddress),
    propertyApn: v.optional(v.string()),
    targetCloseDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)

    if (args.fileNumber.trim() === "") throw new ConvexError("INVALID_FILE_NUMBER")

    const county = await ctx.db.get(args.countyId)
    if (!county) throw new ConvexError("COUNTY_NOT_FOUND")

    const dup = await ctx.db
      .query("files")
      .withIndex("by_tenant_filenumber", (q) =>
        q.eq("tenantId", tc.tenantId).eq("fileNumber", args.fileNumber),
      )
      .unique()
    if (dup) throw new ConvexError("FILE_NUMBER_TAKEN")

    const searchText = buildFileSearchText(
      {
        fileNumber: args.fileNumber,
        transactionType: args.transactionType,
        propertyApn: args.propertyApn,
        propertyAddress: args.propertyAddress,
      },
      county.name,
    )

    const fileId = await ctx.db.insert("files", {
      tenantId: tc.tenantId,
      fileNumber: args.fileNumber,
      stateCode: county.stateCode,
      countyId: args.countyId,
      transactionType: args.transactionType,
      status: "opened",
      propertyAddress: args.propertyAddress,
      propertyApn: args.propertyApn,
      searchText,
      openedAt: Date.now(),
      targetCloseDate: args.targetCloseDate,
    })

    await recordAudit(ctx, tc, "file.created", "file", fileId, {
      fileNumber: args.fileNumber,
      countyId: args.countyId,
    })

    return { fileId }
  },
})

export const get = query({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }) => {
    const tc = await requireTenant(ctx)
    const file = await loadFile(ctx, fileId, tc.tenantId)

    const county = await ctx.db.get(file.countyId)

    const fileParties = await ctx.db
      .query("fileParties")
      .withIndex("by_tenant_file", (q) =>
        q.eq("tenantId", tc.tenantId).eq("fileId", fileId),
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
      }),
    )

    const documents = await ctx.db
      .query("documents")
      .withIndex("by_tenant_file", (q) =>
        q.eq("tenantId", tc.tenantId).eq("fileId", fileId),
      )
      .order("desc")
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
    const tc = await requireTenant(ctx)
    const cap = Math.min(limit ?? 100, 200)

    const rows = status
      ? await ctx.db
          .query("files")
          .withIndex("by_tenant_status", (q) =>
            q.eq("tenantId", tc.tenantId).eq("status", status),
          )
          .order("desc")
          .take(cap)
      : await ctx.db
          .query("files")
          .withIndex("by_tenant_openedAt", (q) =>
            q.eq("tenantId", tc.tenantId),
          )
          .order("desc")
          .take(cap)

    return rows
  },
})

export const setStatus = mutation({
  args: { fileId: v.id("files"), status: fileStatus },
  handler: async (ctx, { fileId, status }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    const file = await loadFile(ctx, fileId, tc.tenantId)

    await ctx.db.patch(fileId, { status })
    await recordAudit(ctx, tc, "file.status_changed", "file", fileId, {
      from: file.status,
      to: status,
    })
    return { ok: true }
  },
})

export const update = mutation({
  args: {
    fileId: v.id("files"),
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
        county?.name ?? null,
      )
    }

    await ctx.db.patch(args.fileId, patch)
    await recordAudit(ctx, tc, "file.updated", "file", args.fileId, {
      fields: Object.keys(patch).filter((k) => k !== "searchText"),
    })
    return { ok: true }
  },
})

export const addParty = mutation({
  args: {
    fileId: v.id("files"),
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

    if (args.legalName.trim() === "") throw new ConvexError("INVALID_LEGAL_NAME")

    const partyId = await ctx.db.insert("parties", {
      tenantId: tc.tenantId,
      partyType: args.partyType,
      legalName: args.legalName.trim(),
      dba: args.dba,
      formationState: args.formationState,
      entitySubtype: args.entitySubtype,
    })

    const filePartyId = await ctx.db.insert("fileParties", {
      tenantId: tc.tenantId,
      fileId: args.fileId,
      partyId,
      role: args.role,
      capacity: args.capacity,
      ownershipPct: args.ownershipPct,
    })

    await recordAudit(ctx, tc, "file.party_added", "file", args.fileId, {
      partyId,
      filePartyId,
      role: args.role,
      legalName: args.legalName,
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
    fileId: v.optional(v.id("files")),
    storageId: v.id("_storage"),
    docType: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, { fileId, storageId, docType, title }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    if (fileId) await loadFile(ctx, fileId, tc.tenantId)

    const meta = await ctx.db.system.get(storageId)
    if (!meta) throw new ConvexError("STORAGE_NOT_FOUND")

    const docId = await ctx.db.insert("documents", {
      tenantId: tc.tenantId,
      fileId,
      docType,
      title,
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
      await recordAudit(ctx, tc, "document.uploaded", "file", fileId, {
        documentId: docId,
        docType,
        sizeBytes: meta.size,
      })
    } else {
      await recordAudit(ctx, tc, "document.uploaded", "document", docId, {
        docType,
        sizeBytes: meta.size,
      })
    }

    // Auto-extract: as soon as the document is recorded against a file, kick
    // off Claude extraction. Reconciliation needs an extraction per doc, so
    // doing it implicitly removes a manual step from the workflow.
    let extractionId: Id<"documentExtractions"> | null = null
    if (fileId) {
      extractionId = await scheduleExtractionFor(ctx, tc.tenantId, {
        documentId: docId,
        fileId,
        storageId,
        docType,
      })
      await recordAudit(ctx, tc, "extraction.requested", "file", fileId, {
        documentId: docId,
        extractionId,
        docType,
        source: "auto",
      })
    }

    return { docId, extractionId }
  },
})

// Cascade-delete a document: its extractions, the storage blob, and the row.
// Caller must verify tenant + role before invoking.
export async function deleteDocumentCascade(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  doc: Doc<"documents">,
) {
  const extractions = await ctx.db
    .query("documentExtractions")
    .withIndex("by_tenant_document", (q) =>
      q.eq("tenantId", tenantId).eq("documentId", doc._id),
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

  await ctx.db.delete(doc._id)
  return { extractionsRemoved: extractions.length }
}

// Insert (or replace) a pending extraction row and schedule the runner.
// Used by both the public upload flow and the CLI seed.
export async function scheduleExtractionFor(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  args: {
    documentId: Id<"documents">
    fileId: Id<"files">
    storageId: Id<"_storage">
    docType: string
  },
): Promise<Id<"documentExtractions">> {
  const prior = await ctx.db
    .query("documentExtractions")
    .withIndex("by_tenant_document", (q) =>
      q.eq("tenantId", tenantId).eq("documentId", args.documentId),
    )
    .unique()
  if (prior) await ctx.db.delete(prior._id)

  const extractionId = await ctx.db.insert("documentExtractions", {
    tenantId,
    fileId: args.fileId,
    documentId: args.documentId,
    status: "pending",
    source: "claude",
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
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)

    const doc = await ctx.db.get(documentId)
    if (!doc || doc.tenantId !== tc.tenantId) {
      throw new ConvexError("DOCUMENT_NOT_FOUND")
    }

    const meta = {
      docType: doc.docType,
      title: doc.title,
      sizeBytes: doc.sizeBytes,
    }

    const result = await deleteDocumentCascade(ctx, tc.tenantId, doc)

    // Audit on the file when there is one so it shows up in the activity feed.
    if (doc.fileId) {
      await recordAudit(ctx, tc, "document.deleted", "file", doc.fileId, {
        documentId,
        ...meta,
        extractionsRemoved: result.extractionsRemoved,
      })
    } else {
      await recordAudit(ctx, tc, "document.deleted", "document", documentId, {
        ...meta,
        extractionsRemoved: result.extractionsRemoved,
      })
    }

    return { ok: true, extractionsRemoved: result.extractionsRemoved }
  },
})

export const documentUrl = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const tc = await requireTenant(ctx)
    const doc = await ctx.db.get(documentId)
    if (!doc || doc.tenantId !== tc.tenantId) {
      throw new ConvexError("DOCUMENT_NOT_FOUND")
    }
    return await ctx.storage.getUrl(doc.storageId)
  },
})
