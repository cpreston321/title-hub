import { ConvexError, v } from 'convex/values'
import { internalMutation, mutation, query } from './_generated/server'
import type { MutationCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { requireRole, requireTenant, type TenantContext } from './lib/tenant'
import { recordAudit } from './lib/audit'
import { normalizeLegalName, type NormalizedName } from './lib/vesting'
import { fanOutNotification } from './notifications'
import { autoPromoteFileStatus } from './files'

type Severity = 'info' | 'warn' | 'block'

const editorRoles = ['owner', 'admin', 'processor'] as const

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
  involvedDocumentIds: Array<Id<'documents'>>
  involvedFields: string[]
  rawDetail: Record<string, unknown>
}

const norm = (s?: string) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

function pickLatestPrice(
  extractions: Array<{
    documentId: Id<'documents'>
    view: ExtractionView
    uploadedAt: number
  }>
): { price: number; documentId: Id<'documents'> } | null {
  // Counter offers supersede purchase agreements; otherwise newest by uploadedAt.
  const byKind = (k: string) =>
    extractions.find(
      (e) =>
        e.view.documentKind === k &&
        e.view.financial?.purchasePrice !== undefined
    )
  const counter = byKind('counter_offer')
  if (counter?.view.financial?.purchasePrice !== undefined) {
    return {
      price: counter.view.financial.purchasePrice,
      documentId: counter.documentId,
    }
  }
  const pa = byKind('purchase_agreement')
  if (pa?.view.financial?.purchasePrice !== undefined) {
    return { price: pa.view.financial.purchasePrice, documentId: pa.documentId }
  }
  return null
}

function comparePrices(
  extractions: Array<{
    documentId: Id<'documents'>
    view: ExtractionView
    uploadedAt: number
  }>,
  out: Pending[]
) {
  const withPrice = extractions.filter(
    (e) => e.view.financial?.purchasePrice !== undefined
  )
  if (withPrice.length < 2) return
  const distinct = new Set(
    withPrice.map((e) => e.view.financial!.purchasePrice as number)
  )
  if (distinct.size <= 1) return

  const pa = withPrice.find((e) => e.view.documentKind === 'purchase_agreement')
  const co = withPrice.find((e) => e.view.documentKind === 'counter_offer')
  const isAmendment = !!pa && !!co
  const latest = pickLatestPrice(withPrice)

  out.push({
    findingType: isAmendment ? 'price_amended' : 'price_mismatch',
    severity: isAmendment ? 'warn' : 'block',
    message: isAmendment
      ? `Counter offer amends the purchase price. Confirm $${
          latest?.price.toLocaleString() ?? '?'
        } is the agreed-on amount before generating closing docs.`
      : `Purchase price differs across documents — closing docs may pull the wrong number.`,
    involvedDocumentIds: withPrice.map((e) => e.documentId),
    involvedFields: ['financial.purchasePrice'],
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
  extractions: Array<{
    documentId: Id<'documents'>
    view: ExtractionView
    uploadedAt: number
  }>,
  out: Pending[]
) {
  const named = extractions.filter((e) => e.view.titleCompany?.name)
  if (named.length === 0) return

  const distinct = new Set(named.map((e) => norm(e.view.titleCompany!.name)))
  if (distinct.size > 1) {
    out.push({
      findingType: 'title_company_change',
      severity: 'warn',
      message: `Title company changes across documents. The amended pick controls — verify before ordering search.`,
      involvedDocumentIds: named.map((e) => e.documentId),
      involvedFields: ['titleCompany.name'],
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
    findingType: 'title_company_set',
    severity: 'info',
    message: `Title company on file: ${named[0].view.titleCompany!.name}.`,
    involvedDocumentIds: named.map((e) => e.documentId),
    involvedFields: ['titleCompany.name'],
    rawDetail: { titleCompany: named[0].view.titleCompany },
  })
}

function compareEarnestMoney(
  extractions: Array<{
    documentId: Id<'documents'>
    view: ExtractionView
    uploadedAt: number
  }>,
  out: Pending[]
) {
  const withEm = extractions.filter(
    (e) => e.view.financial?.earnestMoney !== undefined
  )
  if (withEm.length < 2) return
  const refundabilities = withEm
    .map((e) => e.view.financial?.earnestMoney?.refundable)
    .filter((v) => v !== undefined)
  const set = new Set(refundabilities)
  if (set.size > 1) {
    out.push({
      findingType: 'earnest_money_refundability_change',
      severity: 'block',
      message:
        'Earnest money refundability changes across documents. Mishandling here is a frequent cause of EM disputes — confirm with both parties in writing.',
      involvedDocumentIds: withEm.map((e) => e.documentId),
      involvedFields: ['financial.earnestMoney.refundable'],
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
  extractions: Array<{
    documentId: Id<'documents'>
    view: ExtractionView
    uploadedAt: number
  }>,
  out: Pending[]
) {
  const withDate = extractions.filter((e) => e.view.dates?.closingDate)
  if (withDate.length < 2) return
  const distinct = new Set(withDate.map((e) => e.view.dates!.closingDate))
  if (distinct.size > 1) {
    out.push({
      findingType: 'closing_date_mismatch',
      severity: 'warn',
      message: 'Closing date differs across documents.',
      involvedDocumentIds: withDate.map((e) => e.documentId),
      involvedFields: ['dates.closingDate'],
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
  extractions: Array<{
    documentId: Id<'documents'>
    view: ExtractionView
    uploadedAt: number
  }>,
  out: Pending[]
) {
  const withDays = extractions.filter(
    (e) => typeof e.view.dates?.financingApprovalDays === 'number'
  )
  if (withDays.length < 2) return
  const distinct = new Set(
    withDays.map((e) => e.view.dates!.financingApprovalDays)
  )
  if (distinct.size > 1) {
    out.push({
      findingType: 'financing_window_change',
      severity: 'warn',
      message:
        'Financing approval window changes across documents. The shorter deadline likely controls — make sure the lender knows.',
      involvedDocumentIds: withDays.map((e) => e.documentId),
      involvedFields: ['dates.financingApprovalDays'],
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
  extractions: Array<{
    documentId: Id<'documents'>
    view: ExtractionView
    uploadedAt: number
  }>,
  out: Pending[]
) {
  // Detect party legal-name disagreements per role across documents.
  type Key = string
  const byRole: Record<
    Key,
    Map<
      string,
      Array<{
        documentId: Id<'documents'>
        documentKind?: string
        legalName: string
      }>
    >
  > = {}
  for (const e of extractions) {
    for (const p of e.view.parties ?? []) {
      if (!p.role || !p.legalName) continue
      const role = p.role
      const bucket = (byRole[role] ??= new Map())
      const key = norm(p.legalName)
      const arr = bucket.get(key) ?? (bucket.set(key, []), bucket.get(key)!)
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
        findingType: 'party_name_mismatch',
        severity: 'warn',
        message: `${role} legal name differs across documents. Vesting must match the deed exactly — confirm spelling, capacity, and signing order.`,
        involvedDocumentIds: flat.map((f) => f.documentId),
        involvedFields: ['parties.legalName'],
        rawDetail: { role, names: Array.from(bucket.keys()), perDoc: flat },
      })
    }
  }
}

// Sprint 5: vesting + authority. Run per-document and across documents.
function compareVesting(
  extractions: Array<{
    documentId: Id<'documents'>
    view: ExtractionView
    uploadedAt: number
  }>,
  out: Pending[]
) {
  type Annotated = {
    documentId: Id<'documents'>
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
      (a) => a.norm.isTrust || a.norm.isEstate
    )
    if (trustOrEstateParties.length > 0) {
      const hasTrustee = annotated.some(
        (a) =>
          a.norm.capacity === 'trustee' ||
          a.norm.capacity === 'successor_trustee' ||
          a.extracted === 'trustee' ||
          a.extracted === 'successor_trustee'
      )
      const hasExecutor = annotated.some(
        (a) =>
          a.norm.capacity === 'executor' ||
          a.norm.capacity === 'personal_representative' ||
          a.extracted === 'executor' ||
          a.extracted === 'personal_representative'
      )
      for (const t of trustOrEstateParties) {
        if (t.norm.isTrust && !hasTrustee) {
          out.push({
            findingType: 'trust_without_trustee',
            severity: 'block',
            message: `Trust "${t.raw}" appears without a trustee in the same document. The trustee must sign on behalf of the trust.`,
            involvedDocumentIds: [t.documentId],
            involvedFields: ['parties'],
            rawDetail: { trust: t.raw, documentKind: t.documentKind },
          })
        }
        if (t.norm.isEstate && !hasExecutor) {
          out.push({
            findingType: 'estate_without_executor',
            severity: 'block',
            message: `Estate "${t.raw}" appears without an executor or personal representative. Probate authority is required.`,
            involvedDocumentIds: [t.documentId],
            involvedFields: ['parties'],
            rawDetail: { estate: t.raw, documentKind: t.documentKind },
          })
        }
      }
    }

    // Per-document: joint vesting unclear (2+ buyers/sellers, no vesting form
    // expressed). LLM payloads don't carry vesting form yet, so we proxy it
    // by checking whether the legal name string contains a recognized form.
    const buyers = annotated.filter((a) => a.role === 'buyer')
    const sellers = annotated.filter((a) => a.role === 'seller')
    for (const group of [buyers, sellers]) {
      if (group.length < 2) continue
      const role = group[0].role!
      const anyHasForm = group.some((a) =>
        /\b(JTROS|JTWROS|TIC|TBE|TENANT|COMMUNITY)\b/i.test(a.raw)
      )
      if (!anyHasForm) {
        out.push({
          findingType: 'joint_vesting_unclear',
          severity: 'warn',
          message: `Multiple ${role}s on this document with no vesting form (JTROS/TIC/TBE) — confirm before drafting the deed.`,
          involvedDocumentIds: group.map((g) => g.documentId),
          involvedFields: ['parties'],
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
      a.norm.capacity === 'AIF' ||
      a.norm.capacity === 'POA' ||
      a.extracted === 'AIF' ||
      a.extracted === 'POA'
  )
  if (poaParties.length > 0) {
    out.push({
      findingType: 'poa_present',
      severity: 'warn',
      message: `Power of attorney signing detected (${poaParties[0].raw}). The POA instrument must be recorded with or before the deed.`,
      involvedDocumentIds: [...new Set(poaParties.map((p) => p.documentId))],
      involvedFields: ['parties.capacity'],
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
      a.norm.capacity === 'decedent' ||
      a.extracted === 'decedent' ||
      a.norm.isEstate
  )
  if (decedentParties.length > 0) {
    out.push({
      findingType: 'decedent_indicator',
      severity: 'warn',
      message: `Decedent or estate context detected. Confirm probate status, certified death certificate, and chain of title before clearing.`,
      involvedDocumentIds: [
        ...new Set(decedentParties.map((p) => p.documentId)),
      ],
      involvedFields: ['parties'],
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
      documentId: Id<'documents'>
      documentKind?: string
      capacity?: string
    }>
  >
  const byPersonKey: CapBucket = new Map()
  for (const a of all) {
    if (!a.norm.isPerson || !a.norm.surname) continue
    const key = `${a.norm.surname}|${a.norm.given ?? ''}`
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
    const distinctCapacities = new Set(
      entries.map((e) => e.capacity ?? '_none')
    )
    if (distinctCapacities.size > 1) {
      out.push({
        findingType: 'party_capacity_mismatch',
        severity: 'block',
        message: `Same signer (${key.replace('|', ' ')}) appears with different capacities across documents. Vesting and authority must match the deed.`,
        involvedDocumentIds: entries.map((e) => e.documentId),
        involvedFields: ['parties.capacity'],
        rawDetail: { signer: key, entries },
      })
    }
  }
}

function checkRequiredDocs(
  ctx: MutationCtx,
  file: Doc<'files'>,
  uploadedDocTypes: Set<string>,
  out: Pending[]
): Promise<void> {
  // Looking up the transactionType row to read requiredDocs.
  return ctx.db
    .query('transactionTypes')
    .withIndex('by_code', (q) => q.eq('code', file.transactionType))
    .unique()
    .then((tt) => {
      if (!tt) return
      const missing = tt.requiredDocs.filter((d) => !uploadedDocTypes.has(d))
      if (missing.length === 0) return
      out.push({
        findingType: 'missing_required_documents',
        severity: missing.length >= 2 ? 'warn' : 'info',
        message: `${file.transactionType} requires: ${missing.join(', ')}.`,
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

// Shared core: do the reconciliation work without making any assumption
// about the caller. The public mutation passes a tenant context (and audits
// as the user); the internal/auto path passes a synthetic "system" actor.
async function runReconciliationCore(
  ctx: MutationCtx,
  tenantId: Id<'tenants'>,
  fileId: Id<'files'>,
  actor:
    | { kind: 'user'; tc: TenantContext; trigger: 'manual' }
    | { kind: 'system'; trigger: 'auto' }
) {
  const file = await ctx.db.get(fileId)
  if (!file || file.tenantId !== tenantId) {
    throw new ConvexError('FILE_NOT_FOUND')
  }

  const extractions = await ctx.db
    .query('documentExtractions')
    .withIndex('by_tenant_file', (q) =>
      q.eq('tenantId', tenantId).eq('fileId', fileId)
    )
    .take(100)

  const succeeded = extractions.filter(
    (e) => e.status === 'succeeded' && e.payload
  )

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
    })
  )
  const usable = enriched.filter((e): e is NonNullable<typeof e> => e !== null)
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

  // The user-triggered path uses the existing "wipe open then re-create"
  // policy. The auto path uses the same policy by passing the tenant id
  // through a thin shim.
  const removed = await clearOpenFindings(ctx, tenantId, fileId)

  const now = Date.now()
  const insertedIds: Array<Id<'reconciliationFindings'>> = []
  for (const f of findings) {
    const id = await ctx.db.insert('reconciliationFindings', {
      tenantId,
      fileId,
      findingType: f.findingType,
      severity: f.severity,
      message: f.message,
      involvedDocumentIds: f.involvedDocumentIds,
      involvedFields: f.involvedFields,
      rawDetail: f.rawDetail,
      status: 'open',
      createdAt: now,
    })
    insertedIds.push(id)

    await ctx.runMutation(internal.webhooks.enqueue, {
      tenantId,
      event: 'finding.created',
      payload: {
        findingId: id,
        fileId,
        findingType: f.findingType,
        severity: f.severity,
        message: f.message,
      },
    })
  }

  // Audit: user-triggered records under the member; system-triggered uses a
  // direct insert with no actor.
  const counts = {
    info: findings.filter((f) => f.severity === 'info').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
    block: findings.filter((f) => f.severity === 'block').length,
  }

  // Notify the team about the outcome. We only fan out when there's
  // something to read about — every reconcile run otherwise spams the
  // notification feed.
  const total = counts.info + counts.warn + counts.block
  if (total > 0) {
    await fanOutNotification(ctx, tenantId, {
      kind: 'reconciliation.findings',
      severity: counts.block > 0 ? 'block' : counts.warn > 0 ? 'warn' : 'info',
      title:
        counts.block > 0
          ? `${counts.block} blocker${counts.block === 1 ? '' : 's'} on ${file.fileNumber}`
          : counts.warn > 0
            ? `${counts.warn} warning${counts.warn === 1 ? '' : 's'} on ${file.fileNumber}`
            : `${counts.info} note${counts.info === 1 ? '' : 's'} on ${file.fileNumber}`,
      body:
        actor.kind === 'system'
          ? 'Reconciliation ran automatically after a new extraction.'
          : 'Reconciliation re-run.',
      fileId,
      actorMemberId: actor.kind === 'user' ? actor.tc.memberId : undefined,
      actorType: actor.kind,
    })
  } else if (actor.kind === 'user') {
    // Manual run with all-clear: still worth telling the user.
    await fanOutNotification(ctx, tenantId, {
      kind: 'reconciliation.all_clear',
      severity: 'ok',
      title: `${file.fileNumber} is all clear`,
      body: 'Cross-document checks passed without findings.',
      fileId,
      actorMemberId: actor.tc.memberId,
      actorType: 'user',
    })
  }
  if (actor.kind === 'user') {
    await recordAudit(ctx, actor.tc, 'reconciliation.run', 'file', fileId, {
      removedOpen: removed,
      created: insertedIds.length,
      bySeverity: counts,
      extractionCount: usable.length,
      trigger: actor.trigger,
    })
  } else {
    await ctx.db.insert('auditEvents', {
      tenantId,
      actorType: 'system',
      action: 'reconciliation.run',
      resourceType: 'file',
      resourceId: fileId,
      metadata: {
        removedOpen: removed,
        created: insertedIds.length,
        bySeverity: counts,
        extractionCount: usable.length,
        trigger: actor.trigger,
      },
      occurredAt: Date.now(),
    })
  }

  // Lifecycle nudge: in_exam → cleared once everything reconciles cleanly.
  // We never auto-demote — if findings reappear later the dashboard will show
  // them but the user's manual advance (closing/funded/etc.) stays put.
  if (total === 0) {
    await autoPromoteFileStatus(
      ctx,
      fileId,
      ['in_exam'],
      'cleared',
      'reconciliation_all_clear'
    )
  }

  return {
    findings: insertedIds,
    counts,
  }
}

// Variant of clearExistingFindings that takes raw tenantId so it can be
// called from both the user-context path and the system-context path.
async function clearOpenFindings(
  ctx: MutationCtx,
  tenantId: Id<'tenants'>,
  fileId: Id<'files'>
): Promise<number> {
  let cursor: string | null = null
  let removed = 0
  while (true) {
    const page = await ctx.db
      .query('reconciliationFindings')
      .withIndex('by_tenant_file_status', (q) =>
        q.eq('tenantId', tenantId).eq('fileId', fileId).eq('status', 'open')
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
  args: { fileId: v.id('files') },
  handler: async (ctx, { fileId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    return await runReconciliationCore(ctx, tc.tenantId, fileId, {
      kind: 'user',
      tc,
      trigger: 'manual',
    })
  },
})

// Auto-trigger entry point: scheduled after a successful extraction so
// reconciliation always reflects the latest set of extracted facts. No
// auth context — the caller is the platform itself.
export const runForFileAuto = internalMutation({
  args: {
    tenantId: v.id('tenants'),
    fileId: v.id('files'),
  },
  handler: async (ctx, { tenantId, fileId }) => {
    return await runReconciliationCore(ctx, tenantId, fileId, {
      kind: 'system',
      trigger: 'auto',
    })
  },
})

export const listForFile = query({
  args: {
    fileId: v.id('files'),
    status: v.optional(
      v.union(
        v.literal('open'),
        v.literal('acknowledged'),
        v.literal('resolved'),
        v.literal('dismissed')
      )
    ),
  },
  handler: async (ctx, { fileId, status }) => {
    const tc = await requireTenant(ctx)
    if (status) {
      return await ctx.db
        .query('reconciliationFindings')
        .withIndex('by_tenant_file_status', (q) =>
          q
            .eq('tenantId', tc.tenantId)
            .eq('fileId', fileId)
            .eq('status', status)
        )
        .order('desc')
        .take(200)
    }
    return await ctx.db
      .query('reconciliationFindings')
      .withIndex('by_tenant_file', (q) =>
        q.eq('tenantId', tc.tenantId).eq('fileId', fileId)
      )
      .order('desc')
      .take(200)
  },
})

export const setStatus = mutation({
  args: {
    findingId: v.id('reconciliationFindings'),
    status: v.union(
      v.literal('open'),
      v.literal('acknowledged'),
      v.literal('resolved'),
      v.literal('dismissed')
    ),
  },
  handler: async (ctx, { findingId, status }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    const finding = await ctx.db.get(findingId)
    if (!finding || finding.tenantId !== tc.tenantId) {
      throw new ConvexError('FINDING_NOT_FOUND')
    }
    await ctx.db.patch(findingId, {
      status,
      resolvedByMemberId:
        status === 'resolved' || status === 'dismissed'
          ? tc.memberId
          : undefined,
      resolvedAt:
        status === 'resolved' || status === 'dismissed'
          ? Date.now()
          : undefined,
    })
    await recordAudit(
      ctx,
      tc,
      'finding.status_changed',
      'file',
      finding.fileId,
      { findingId, from: finding.status, to: status }
    )
    if (status === 'resolved') {
      await ctx.runMutation(internal.webhooks.enqueue, {
        tenantId: tc.tenantId,
        event: 'finding.resolved',
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
// open findings). When the finding maps to a known file or party field, the
// chosen value is also promoted to the file/party as the system of record.
export const resolveWith = mutation({
  args: {
    findingId: v.id('reconciliationFindings'),
    documentId: v.id('documents'),
    value: v.optional(v.any()),
  },
  handler: async (ctx, { findingId, documentId, value }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    const finding = await ctx.db.get(findingId)
    if (!finding || finding.tenantId !== tc.tenantId) {
      throw new ConvexError('FINDING_NOT_FOUND')
    }
    // The chosen document must be one of the documents the finding cited.
    if (!finding.involvedDocumentIds.includes(documentId)) {
      throw new ConvexError('DOCUMENT_NOT_INVOLVED')
    }
    const doc = await ctx.db.get(documentId)
    if (!doc || doc.tenantId !== tc.tenantId) {
      throw new ConvexError('DOCUMENT_NOT_FOUND')
    }

    const now = Date.now()
    await ctx.db.patch(findingId, {
      status: 'resolved',
      resolvedByMemberId: tc.memberId,
      resolvedAt: now,
      resolvedDocumentId: documentId,
      resolvedValue: value,
    })

    const promoted = await promoteToGroundTruth(ctx, tc, finding, value)

    await recordAudit(
      ctx,
      tc,
      'finding.resolved_with',
      'file',
      finding.fileId,
      {
        findingId,
        findingType: finding.findingType,
        chosenDocumentId: documentId,
        chosenDocType: doc.docType,
        chosenValue: value,
        from: finding.status,
        promoted: promoted ?? null,
      }
    )

    await ctx.runMutation(internal.webhooks.enqueue, {
      tenantId: tc.tenantId,
      event: 'finding.resolved',
      payload: {
        findingId,
        fileId: finding.fileId,
        findingType: finding.findingType,
        chosenDocumentId: documentId,
        chosenValue: value,
        promoted: promoted ?? null,
      },
    })

    // Promoting a value to ground truth can change what reconciliation
    // produces on the next pass — re-run via the unified fan-out so other
    // findings that share the same field clear automatically.
    if (promoted) {
      await ctx.scheduler.runAfter(0, internal.pipeline.onFileChange, {
        tenantId: tc.tenantId,
        fileId: finding.fileId,
        reason: 'finding_resolved',
      })
    }

    return { ok: true, promoted }
  },
})

type Promotion = {
  target: 'file' | 'party'
  id: string
  fields: string[]
}

// Map a resolved finding to the file/party field that should now hold the
// authoritative value. Returns null when the finding type doesn't have a
// canonical destination, when the value's shape is wrong for the target, or
// when ambiguity prevents a safe write (e.g. multiple buyers on a file).
async function promoteToGroundTruth(
  ctx: MutationCtx,
  tc: TenantContext,
  finding: Doc<'reconciliationFindings'>,
  value: unknown
): Promise<Promotion | null> {
  const fileId = finding.fileId
  switch (finding.findingType) {
    case 'price_mismatch':
    case 'price_amended':
      if (typeof value === 'number' && Number.isFinite(value)) {
        await ctx.db.patch(fileId, { purchasePrice: value })
        return { target: 'file', id: fileId, fields: ['purchasePrice'] }
      }
      return null
    case 'title_company_change':
    case 'title_company_set':
      if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>
        await ctx.db.patch(fileId, {
          titleCompany: {
            name: typeof obj.name === 'string' ? obj.name : undefined,
            phone: typeof obj.phone === 'string' ? obj.phone : undefined,
            selectedBy:
              typeof obj.selectedBy === 'string' ? obj.selectedBy : undefined,
          },
        })
        return { target: 'file', id: fileId, fields: ['titleCompany'] }
      }
      return null
    case 'earnest_money_refundability_change':
      if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>
        await ctx.db.patch(fileId, {
          earnestMoney: {
            amount: typeof obj.amount === 'number' ? obj.amount : undefined,
            refundable:
              typeof obj.refundable === 'boolean' ? obj.refundable : undefined,
            depositDays:
              typeof obj.depositDays === 'number' ? obj.depositDays : undefined,
          },
        })
        return { target: 'file', id: fileId, fields: ['earnestMoney'] }
      }
      return null
    case 'closing_date_mismatch':
      if (typeof value === 'string') {
        const ts = Date.parse(value)
        if (!Number.isNaN(ts)) {
          await ctx.db.patch(fileId, { targetCloseDate: ts })
          return { target: 'file', id: fileId, fields: ['targetCloseDate'] }
        }
      }
      return null
    case 'financing_window_change':
      if (typeof value === 'number' && Number.isFinite(value)) {
        await ctx.db.patch(fileId, { financingApprovalDays: value })
        return { target: 'file', id: fileId, fields: ['financingApprovalDays'] }
      }
      return null
    case 'party_name_mismatch': {
      const rd = (finding.rawDetail ?? {}) as Record<string, unknown>
      const role = rd.role
      if (typeof role !== 'string' || typeof value !== 'string') return null
      const trimmed = value.trim()
      if (trimmed === '') return null
      const fps = await ctx.db
        .query('fileParties')
        .withIndex('by_tenant_file', (q) =>
          q.eq('tenantId', tc.tenantId).eq('fileId', fileId)
        )
        .take(50)
      const matches = fps.filter((fp) => fp.role === role)
      if (matches.length !== 1) return null
      const partyId = matches[0].partyId
      const party = await ctx.db.get(partyId)
      if (!party || party.tenantId !== tc.tenantId) return null
      await ctx.db.patch(partyId, { legalName: trimmed })
      return { target: 'party', id: partyId, fields: ['legalName'] }
    }
    default:
      return null
  }
}
