import { ConvexError, v } from "convex/values"
import { mutation, query } from "./_generated/server"
import type { QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { requireRole, requireTenant } from "./lib/tenant"
import { recordAudit } from "./lib/audit"
import { fileStatus, partyType, propertyAddress } from "./schema"

const editorRoles = ["owner", "admin", "processor"] as const

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

    const fileId = await ctx.db.insert("files", {
      tenantId: tc.tenantId,
      fileNumber: args.fileNumber,
      stateCode: county.stateCode,
      countyId: args.countyId,
      transactionType: args.transactionType,
      status: "opened",
      propertyAddress: args.propertyAddress,
      propertyApn: args.propertyApn,
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

    return { docId }
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
