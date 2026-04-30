import { ConvexError, v } from "convex/values"
import { mutation, query } from "./_generated/server"
import type { MutationCtx } from "./_generated/server"
import { internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import { requireRole, requireTenant, type TenantContext } from "./lib/tenant"
import { recordAudit } from "./lib/audit"
import { normalizeLegalName, type NormalizedName } from "./lib/vesting"

type Severity = "info" | "warn" | "block"

const editorRoles = ["owner", "admin", "processor"] as const

// Shape of the LLM extraction payload we read from documentExtractions.payload.
// Mirrors the schema in convex/extractionsRunner.ts. Kept loose (no validator)
// because the payload is JSON from an LLM.
type ExtractionView = {
  documentKind?: string
  parties?: Array<{ role?: string; legalName?: string; capacity?: string }>
  property?: {
    address?: string
    legalDescription?: string
    parcelId?: string
  } | null
  financial?: {
    purchasePrice?: number
    earnestMoney?: { amount?: number; refundable?: boolean }
    sellerConcessions?: number
  } | null
  dates?: {
    effectiveDate?: string
    closingDate?: string
    financingApprovalDays?: number
  } | null
  titleCompany?: { name?: string; phone?: string; selectedBy?: string } | null
  contingencies?: string[]
  amendments?: string[]
  notes?: string[]
}

type Pending = {
  findingType: string
  severity: Severity
  message: string
  involvedDocumentIds: Array<Id<"documents">>
  involvedFields: string[]
  rawDetail: Record<string, unknown>
}

const norm = (s?: string) =>
  (s ?? "").trim().toLowerCase().replace(/\s+/g, " ")

function pickLatestPrice(
  extractions: Array<{ documentId: Id<"documents">; view: ExtractionView; uploadedAt: number }>,
): { price: number; documentId: Id<"documents"> } | null {
  // Counter offers supersede purchase agreements; otherwise newest by uploadedAt.
  const byKind = (k: string) =>
    extractions.find((e) => e.view.documentKind === k && e.view.financial?.purchasePrice !== undefined)
  const counter = byKind("counter_offer")
  if (counter?.view.financial?.purchasePrice !== undefined) {
    return { price: counter.view.financial.purchasePrice, documentId: counter.documentId }
  }
  const pa = byKind("purchase_agreement")
  if (pa?.view.financial?.purchasePrice !== undefined) {
    return { price: pa.view.financial.purchasePrice, documentId: pa.documentId }
  }
  return null
}

function comparePrices(
  extractions: Array<{ documentId: Id<"documents">; view: ExtractionView; uploadedAt: number }>,
  out: Pending[],
) {
  const withPrice = extractions.filter(
    (e) => e.view.financial?.purchasePrice !== undefined,
  )
  if (withPrice.length < 2) return
  const distinct = new Set(
    withPrice.map((e) => e.view.financial!.purchasePrice as number),
  )
  if (distinct.size <= 1) return

  const pa = withPrice.find((e) => e.view.documentKind === "purchase_agreement")
  const co = withPrice.find((e) => e.view.documentKind === "counter_offer")
  const isAmendment = !!pa && !!co
  const latest = pickLatestPrice(withPrice)

  out.push({
    findingType: isAmendment ? "price_amended" : "price_mismatch",
    severity: isAmendment ? "warn" : "block",
    message: isAmendment
      ? `Counter offer amends the purchase price. Confirm $${
          latest?.price.toLocaleString() ?? "?"
        } is the agreed-on amount before generating closing docs.`
      : `Purchase price differs across documents — closing docs may pull the wrong number.`,
    involvedDocumentIds: withPrice.map((e) => e.documentId),
    involvedFields: ["financial.purchasePrice"],
    rawDetail: {
      values: withPrice.map((e) => ({
        documentId: e.documentId,
        documentKind: e.view.documentKind,
        purchasePrice: e.view.financial?.purchasePrice,
      })),
      latest,
    },
  })
}

function compareTitleCompany(
  extractions: Array<{ documentId: Id<"documents">; view: ExtractionView; uploadedAt: number }>,
  out: Pending[],
) {
  const named = extractions.filter((e) => e.view.titleCompany?.name)
  if (named.length === 0) return

  const distinct = new Set(named.map((e) => norm(e.view.titleCompany!.name)))
  if (distinct.size > 1) {
    out.push({
      findingType: "title_company_change",
      severity: "warn",
      message: `Title company changes across documents. The amended pick controls — verify before ordering search.`,
      involvedDocumentIds: named.map((e) => e.documentId),
      involvedFields: ["titleCompany.name"],
      rawDetail: {
        values: named.map((e) => ({
          documentId: e.documentId,
          documentKind: e.view.documentKind,
          titleCompany: e.view.titleCompany,
        })),
      },
    })
    return
  }

  // Single title company across docs — surface as info so the user sees it
  // wired up correctly.
  out.push({
    findingType: "title_company_set",
    severity: "info",
    message: `Title company on file: ${named[0].view.titleCompany!.name}.`,
    involvedDocumentIds: named.map((e) => e.documentId),
    involvedFields: ["titleCompany.name"],
    rawDetail: { titleCompany: named[0].view.titleCompany },
  })
}

function compareEarnestMoney(
  extractions: Array<{ documentId: Id<"documents">; view: ExtractionView; uploadedAt: number }>,
  out: Pending[],
) {
  const withEm = extractions.filter(
    (e) => e.view.financial?.earnestMoney !== undefined,
  )
  if (withEm.length < 2) return
  const refundabilities = withEm
    .map((e) => e.view.financial?.earnestMoney?.refundable)
    .filter((v) => v !== undefined)
  const set = new Set(refundabilities)
  if (set.size > 1) {
    out.push({
      findingType: "earnest_money_refundability_change",
      severity: "block",
      message:
        "Earnest money refundability changes across documents. Mishandling here is a frequent cause of EM disputes — confirm with both parties in writing.",
      involvedDocumentIds: withEm.map((e) => e.documentId),
      involvedFields: ["financial.earnestMoney.refundable"],
      rawDetail: {
        values: withEm.map((e) => ({
          documentId: e.documentId,
          documentKind: e.view.documentKind,
          earnestMoney: e.view.financial?.earnestMoney,
        })),
      },
    })
  }
}

function compareClosingDate(
  extractions: Array<{ documentId: Id<"documents">; view: ExtractionView; uploadedAt: number }>,
  out: Pending[],
) {
  const withDate = extractions.filter((e) => e.view.dates?.closingDate)
  if (withDate.length < 2) return
  const distinct = new Set(withDate.map((e) => e.view.dates!.closingDate))
  if (distinct.size > 1) {
    out.push({
      findingType: "closing_date_mismatch",
      severity: "warn",
      message: "Closing date differs across documents.",
      involvedDocumentIds: withDate.map((e) => e.documentId),
      involvedFields: ["dates.closingDate"],
      rawDetail: {
        values: withDate.map((e) => ({
          documentId: e.documentId,
          documentKind: e.view.documentKind,
          closingDate: e.view.dates?.closingDate,
        })),
      },
    })
  }
}

function compareFinancingWindow(
  extractions: Array<{ documentId: Id<"documents">; view: ExtractionView; uploadedAt: number }>,
  out: Pending[],
) {
  const withDays = extractions.filter(
    (e) => typeof e.view.dates?.financingApprovalDays === "number",
  )
  if (withDays.length < 2) return
  const distinct = new Set(
    withDays.map((e) => e.view.dates!.financingApprovalDays),
  )
  if (distinct.size > 1) {
    out.push({
      findingType: "financing_window_change",
      severity: "warn",
      message:
        "Financing approval window changes across documents. The shorter deadline likely controls — make sure the lender knows.",
      involvedDocumentIds: withDays.map((e) => e.documentId),
      involvedFields: ["dates.financingApprovalDays"],
      rawDetail: {
        values: withDays.map((e) => ({
          documentId: e.documentId,
          documentKind: e.view.documentKind,
          financingApprovalDays: e.view.dates?.financingApprovalDays,
        })),
      },
    })
  }
}

function compareParties(
  extractions: Array<{ documentId: Id<"documents">; view: ExtractionView; uploadedAt: number }>,
  out: Pending[],
) {
  // Detect party legal-name disagreements per role across documents.
  type Key = string
  const byRole: Record<Key, Map<string, Array<{ documentId: Id<"documents">; documentKind?: string; legalName: string }>>> = {}
  for (const e of extractions) {
    for (const p of e.view.parties ?? []) {
      if (!p.role || !p.legalName) continue
      const role = p.role
      const bucket = (byRole[role] ??= new Map())
      const key = norm(p.legalName)
      const arr =
        bucket.get(key) ?? (bucket.set(key, []), bucket.get(key)!)
      arr.push({
        documentId: e.documentId,
        documentKind: e.view.documentKind,
        legalName: p.legalName,
      })
    }
  }
  for (const [role, bucket] of Object.entries(byRole)) {
    if (bucket.size > 1) {
      const flat = Array.from(bucket.values()).flat()
      out.push({
        findingType: "party_name_mismatch",
        severity: "warn",
        message: `${role} legal name differs across documents. Vesting must match the deed exactly — confirm spelling, capacity, and signing order.`,
        involvedDocumentIds: flat.map((f) => f.documentId),
        involvedFields: ["parties.legalName"],
        rawDetail: { role, names: Array.from(bucket.keys()), perDoc: flat },
      })
    }
  }
}

// Sprint 5: vesting + authority. Run per-document and across documents.
function compareVesting(
  extractions: Array<{
    documentId: Id<"documents">
    view: ExtractionView
    uploadedAt: number
  }>,
  out: Pending[],
) {
  type Annotated = {
    documentId: Id<"documents">
    documentKind?: string
    role?: string
    raw: string
    extracted?: string // capacity from extraction payload
    norm: NormalizedName
  }

  const all: Annotated[] = []

  for (const e of extractions) {
    const parties = e.view.parties ?? []

    const annotated: Annotated[] = parties
      .filter((p) => !!p.legalName)
      .map((p) => ({
        documentId: e.documentId,
        documentKind: e.view.documentKind,
        role: p.role,
        raw: p.legalName!,
        extracted: p.capacity,
        norm: normalizeLegalName(p.legalName!),
      }))
    all.push(...annotated)

    // Per-document: trust without trustee, estate without executor
    const trustOrEstateParties = annotated.filter(
      (a) => a.norm.isTrust || a.norm.isEstate,
    )
    if (trustOrEstateParties.length > 0) {
      const hasTrustee = annotated.some(
        (a) =>
          a.norm.capacity === "trustee" ||
          a.norm.capacity === "successor_trustee" ||
          a.extracted === "trustee" ||
          a.extracted === "successor_trustee",
      )
      const hasExecutor = annotated.some(
        (a) =>
          a.norm.capacity === "executor" ||
          a.norm.capacity === "personal_representative" ||
          a.extracted === "executor" ||
          a.extracted === "personal_representative",
      )
      for (const t of trustOrEstateParties) {
        if (t.norm.isTrust && !hasTrustee) {
          out.push({
            findingType: "trust_without_trustee",
            severity: "block",
            message: `Trust "${t.raw}" appears without a trustee in the same document. The trustee must sign on behalf of the trust.`,
            involvedDocumentIds: [t.documentId],
            involvedFields: ["parties"],
            rawDetail: { trust: t.raw, documentKind: t.documentKind },
          })
        }
        if (t.norm.isEstate && !hasExecutor) {
          out.push({
            findingType: "estate_without_executor",
            severity: "block",
            message: `Estate "${t.raw}" appears without an executor or personal representative. Probate authority is required.`,
            involvedDocumentIds: [t.documentId],
            involvedFields: ["parties"],
            rawDetail: { estate: t.raw, documentKind: t.documentKind },
          })
        }
      }
    }

    // Per-document: joint vesting unclear (2+ buyers/sellers, no vesting form
    // expressed). LLM payloads don't carry vesting form yet, so we proxy it
    // by checking whether the legal name string contains a recognized form.
    const buyers = annotated.filter((a) => a.role === "buyer")
    const sellers = annotated.filter((a) => a.role === "seller")
    for (const group of [buyers, sellers]) {
      if (group.length < 2) continue
      const role = group[0].role!
      const anyHasForm = group.some((a) =>
        /\b(JTROS|JTWROS|TIC|TBE|TENANT|COMMUNITY)\b/i.test(a.raw),
      )
      if (!anyHasForm) {
        out.push({
          findingType: "joint_vesting_unclear",
          severity: "warn",
          message: `Multiple ${role}s on this document with no vesting form (JTROS/TIC/TBE) — confirm before drafting the deed.`,
          involvedDocumentIds: group.map((g) => g.documentId),
          involvedFields: ["parties"],
          rawDetail: {
            role,
            names: group.map((g) => g.raw),
            documentKind: group[0].documentKind,
          },
        })
        break // one finding per doc per role-group
      }
    }
  }

  // Cross-document and aggregate flags
  const poaParties = all.filter(
    (a) =>
      a.norm.capacity === "AIF" ||
      a.norm.capacity === "POA" ||
      a.extracted === "AIF" ||
      a.extracted === "POA",
  )
  if (poaParties.length > 0) {
    out.push({
      findingType: "poa_present",
      severity: "warn",
      message: `Power of attorney signing detected (${poaParties[0].raw}). The POA instrument must be recorded with or before the deed.`,
      involvedDocumentIds: [...new Set(poaParties.map((p) => p.documentId))],
      involvedFields: ["parties.capacity"],
      rawDetail: {
        signers: poaParties.map((p) => ({
          name: p.raw,
          capacity: p.norm.capacity ?? p.extracted,
          documentKind: p.documentKind,
        })),
      },
    })
  }

  const decedentParties = all.filter(
    (a) =>
      a.norm.capacity === "decedent" || a.extracted === "decedent" ||
      a.norm.isEstate,
  )
  if (decedentParties.length > 0) {
    out.push({
      findingType: "decedent_indicator",
      severity: "warn",
      message: `Decedent or estate context detected. Confirm probate status, certified death certificate, and chain of title before clearing.`,
      involvedDocumentIds: [...new Set(decedentParties.map((p) => p.documentId))],
      involvedFields: ["parties"],
      rawDetail: {
        parties: decedentParties.map((p) => ({
          name: p.raw,
          documentKind: p.documentKind,
        })),
      },
    })
  }

  // Capacity mismatch across documents (same surname/given pair, different capacity)
  type CapBucket = Map<
    string,
    Array<{
      documentId: Id<"documents">
      documentKind?: string
      capacity?: string
    }>
  >
  const byPersonKey: CapBucket = new Map()
  for (const a of all) {
    if (!a.norm.isPerson || !a.norm.surname) continue
    const key = `${a.norm.surname}|${a.norm.given ?? ""}`
    const arr = byPersonKey.get(key) ?? []
    arr.push({
      documentId: a.documentId,
      documentKind: a.documentKind,
      capacity: a.norm.capacity ?? a.extracted,
    })
    byPersonKey.set(key, arr)
  }
  for (const [key, entries] of byPersonKey.entries()) {
    if (entries.length < 2) continue
    const distinctCapacities = new Set(entries.map((e) => e.capacity ?? "_none"))
    if (distinctCapacities.size > 1) {
      out.push({
        findingType: "party_capacity_mismatch",
        severity: "block",
        message: `Same signer (${key.replace("|", " ")}) appears with different capacities across documents. Vesting and authority must match the deed.`,
        involvedDocumentIds: entries.map((e) => e.documentId),
        involvedFields: ["parties.capacity"],
        rawDetail: { signer: key, entries },
      })
    }
  }
}

function checkRequiredDocs(
  ctx: MutationCtx,
  file: Doc<"files">,
  uploadedDocTypes: Set<string>,
  out: Pending[],
): Promise<void> {
  // Looking up the transactionType row to read requiredDocs.
  return ctx.db
    .query("transactionTypes")
    .withIndex("by_code", (q) => q.eq("code", file.transactionType))
    .unique()
    .then((tt) => {
      if (!tt) return
      const missing = tt.requiredDocs.filter((d) => !uploadedDocTypes.has(d))
      if (missing.length === 0) return
      out.push({
        findingType: "missing_required_documents",
        severity: missing.length >= 2 ? "warn" : "info",
        message: `${file.transactionType} requires: ${missing.join(", ")}.`,
        involvedDocumentIds: [],
        involvedFields: [],
        rawDetail: {
          transactionType: file.transactionType,
          missing,
          uploaded: Array.from(uploadedDocTypes),
        },
      })
    })
}

async function clearExistingFindings(
  ctx: MutationCtx,
  tc: TenantContext,
  fileId: Id<"files">,
) {
  // Open findings get superseded by a fresh run; resolved/dismissed ones stay
  // for audit. The simplest mental model for the operator: "rerun = wipe pending."
  let cursor: string | null = null
  let removed = 0
  while (true) {
    const page = await ctx.db
      .query("reconciliationFindings")
      .withIndex("by_tenant_file_status", (q) =>
        q.eq("tenantId", tc.tenantId).eq("fileId", fileId).eq("status", "open"),
      )
      .paginate({ numItems: 100, cursor })
    for (const f of page.page) {
      await ctx.db.delete(f._id)
      removed++
    }
    if (page.isDone) break
    cursor = page.continueCursor
  }
  return removed
}

export const runForFile = mutation({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)

    const file = await ctx.db.get(fileId)
    if (!file || file.tenantId !== tc.tenantId) {
      throw new ConvexError("FILE_NOT_FOUND")
    }

    const extractions = await ctx.db
      .query("documentExtractions")
      .withIndex("by_tenant_file", (q) =>
        q.eq("tenantId", tc.tenantId).eq("fileId", fileId),
      )
      .take(100)

    const succeeded = extractions.filter(
      (e) => e.status === "succeeded" && e.payload,
    )

    // Fetch the underlying documents to know docType + uploadedAt for
    // ordering and required-doc checks.
    const enriched = await Promise.all(
      succeeded.map(async (e) => {
        const doc = await ctx.db.get(e.documentId)
        return doc
          ? {
              documentId: e.documentId,
              uploadedAt: doc.uploadedAt,
              docType: doc.docType,
              view: e.payload as ExtractionView,
            }
          : null
      }),
    )
    const usable = enriched.filter(
      (e): e is NonNullable<typeof e> => e !== null,
    )
    usable.sort((a, b) => b.uploadedAt - a.uploadedAt) // newest first

    const findings: Pending[] = []
    comparePrices(usable, findings)
    compareTitleCompany(usable, findings)
    compareEarnestMoney(usable, findings)
    compareClosingDate(usable, findings)
    compareFinancingWindow(usable, findings)
    compareParties(usable, findings)
    compareVesting(usable, findings)

    const uploadedDocTypes = new Set(usable.map((e) => e.docType))
    await checkRequiredDocs(ctx, file, uploadedDocTypes, findings)

    const removed = await clearExistingFindings(ctx, tc, fileId)

    const now = Date.now()
    const insertedIds: Array<Id<"reconciliationFindings">> = []
    for (const f of findings) {
      const id = await ctx.db.insert("reconciliationFindings", {
        tenantId: tc.tenantId,
        fileId,
        findingType: f.findingType,
        severity: f.severity,
        message: f.message,
        involvedDocumentIds: f.involvedDocumentIds,
        involvedFields: f.involvedFields,
        rawDetail: f.rawDetail,
        status: "open",
        createdAt: now,
      })
      insertedIds.push(id)

      // Fan out to subscribed webhooks. Best-effort — failures are tracked
      // in webhookDeliveries, not surfaced to the reconciliation result.
      await ctx.runMutation(internal.webhooks.enqueue, {
        tenantId: tc.tenantId,
        event: "finding.created",
        payload: {
          findingId: id,
          fileId,
          findingType: f.findingType,
          severity: f.severity,
          message: f.message,
        },
      })
    }

    await recordAudit(ctx, tc, "reconciliation.run", "file", fileId, {
      removedOpen: removed,
      created: insertedIds.length,
      bySeverity: {
        info: findings.filter((f) => f.severity === "info").length,
        warn: findings.filter((f) => f.severity === "warn").length,
        block: findings.filter((f) => f.severity === "block").length,
      },
      extractionCount: usable.length,
    })

    return {
      findings: insertedIds,
      counts: {
        info: findings.filter((f) => f.severity === "info").length,
        warn: findings.filter((f) => f.severity === "warn").length,
        block: findings.filter((f) => f.severity === "block").length,
      },
    }
  },
})

export const listForFile = query({
  args: {
    fileId: v.id("files"),
    status: v.optional(
      v.union(
        v.literal("open"),
        v.literal("acknowledged"),
        v.literal("resolved"),
        v.literal("dismissed"),
      ),
    ),
  },
  handler: async (ctx, { fileId, status }) => {
    const tc = await requireTenant(ctx)
    if (status) {
      return await ctx.db
        .query("reconciliationFindings")
        .withIndex("by_tenant_file_status", (q) =>
          q.eq("tenantId", tc.tenantId).eq("fileId", fileId).eq("status", status),
        )
        .order("desc")
        .take(200)
    }
    return await ctx.db
      .query("reconciliationFindings")
      .withIndex("by_tenant_file", (q) =>
        q.eq("tenantId", tc.tenantId).eq("fileId", fileId),
      )
      .order("desc")
      .take(200)
  },
})

export const setStatus = mutation({
  args: {
    findingId: v.id("reconciliationFindings"),
    status: v.union(
      v.literal("open"),
      v.literal("acknowledged"),
      v.literal("resolved"),
      v.literal("dismissed"),
    ),
  },
  handler: async (ctx, { findingId, status }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    const finding = await ctx.db.get(findingId)
    if (!finding || finding.tenantId !== tc.tenantId) {
      throw new ConvexError("FINDING_NOT_FOUND")
    }
    await ctx.db.patch(findingId, {
      status,
      resolvedByMemberId:
        status === "resolved" || status === "dismissed"
          ? tc.memberId
          : undefined,
      resolvedAt:
        status === "resolved" || status === "dismissed" ? Date.now() : undefined,
    })
    await recordAudit(
      ctx,
      tc,
      "finding.status_changed",
      "file",
      finding.fileId,
      { findingId, from: finding.status, to: status },
    )
    if (status === "resolved") {
      await ctx.runMutation(internal.webhooks.enqueue, {
        tenantId: tc.tenantId,
        event: "finding.resolved",
        payload: {
          findingId,
          fileId: finding.fileId,
          findingType: finding.findingType,
        },
      })
    }
    return { ok: true }
  },
})

// Resolve a mismatch by picking which involved document is authoritative.
// The picked document and the value taken from it are persisted on the
// finding so the decision survives re-reconciliation runs (which only wipe
// open findings).
export const resolveWith = mutation({
  args: {
    findingId: v.id("reconciliationFindings"),
    documentId: v.id("documents"),
    value: v.optional(v.any()),
  },
  handler: async (ctx, { findingId, documentId, value }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    const finding = await ctx.db.get(findingId)
    if (!finding || finding.tenantId !== tc.tenantId) {
      throw new ConvexError("FINDING_NOT_FOUND")
    }
    // The chosen document must be one of the documents the finding cited.
    if (!finding.involvedDocumentIds.includes(documentId)) {
      throw new ConvexError("DOCUMENT_NOT_INVOLVED")
    }
    const doc = await ctx.db.get(documentId)
    if (!doc || doc.tenantId !== tc.tenantId) {
      throw new ConvexError("DOCUMENT_NOT_FOUND")
    }

    const now = Date.now()
    await ctx.db.patch(findingId, {
      status: "resolved",
      resolvedByMemberId: tc.memberId,
      resolvedAt: now,
      resolvedDocumentId: documentId,
      resolvedValue: value,
    })

    await recordAudit(
      ctx,
      tc,
      "finding.resolved_with",
      "file",
      finding.fileId,
      {
        findingId,
        findingType: finding.findingType,
        chosenDocumentId: documentId,
        chosenDocType: doc.docType,
        chosenValue: value,
        from: finding.status,
      },
    )

    await ctx.runMutation(internal.webhooks.enqueue, {
      tenantId: tc.tenantId,
      event: "finding.resolved",
      payload: {
        findingId,
        fileId: finding.fileId,
        findingType: finding.findingType,
        chosenDocumentId: documentId,
        chosenValue: value,
      },
    })

    return { ok: true }
  },
})
