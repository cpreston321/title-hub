/**
 * Closing Day mode — one screen for every file closing in the next N days.
 *
 * The checklist on a file is a mix of:
 *   • derived signals (we can compute these from extractions, findings,
 *     party rows, doc rows): property/parties/docs uploaded, required
 *     docs extracted, no open blockers, wire instructions verified,
 *     closing disclosure on file, title commitment cleared.
 *   • human attestations (we can't derive these): CPL issued, funds
 *     confirmed in escrow, IDs verified at signing. Each is a row in
 *     `closingAttestations` keyed by (file, item).
 *
 * The ALTA Best Practices Pillar 3 controls map directly onto this list,
 * so the screen doubles as a per-file compliance trail.
 */
import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import { optionalTenant, requireRole, requireTenant } from './lib/tenant'
import { recordAudit } from './lib/audit'

const editorRoles = ['owner', 'admin', 'processor', 'closer'] as const

// Items that need a human to attest. Surface these in the UI as a checkbox
// + optional note. The literal-union enforces consistency between schema
// readers/writers without polluting the schema with a strict validator.
const ATTEST_ITEMS = [
  'cpl_issued',
  'funds_confirmed',
  'ids_verified',
  'wire_phone_verified',
  'survey_reviewed',
  'lender_package_returned',
] as const
const attestItem = v.union(
  v.literal('cpl_issued'),
  v.literal('funds_confirmed'),
  v.literal('ids_verified'),
  v.literal('wire_phone_verified'),
  v.literal('survey_reviewed'),
  v.literal('lender_package_returned')
)
type AttestItem = (typeof ATTEST_ITEMS)[number]

// Items derived from facts on the file. These never need attestation —
// they're either green (derived signal passes) or red (the user has to
// fix the underlying problem before they go green).
const DERIVED_ITEMS = [
  'property_address',
  'parties_complete',
  'required_docs_extracted',
  'no_open_blockers',
  'wire_no_unresolved_alerts',
  'closing_disclosure_on_file',
  'title_commitment_cleared',
] as const
type DerivedItem = (typeof DERIVED_ITEMS)[number]

export type ChecklistItem = {
  id: AttestItem | DerivedItem
  label: string
  description: string
  kind: 'derived' | 'attestation'
  status: 'pass' | 'fail' | 'pending'
  note?: string
  attestedByEmail?: string | null
  attestedAt?: number | null
}

const ITEM_LABELS: Record<AttestItem | DerivedItem, { label: string; description: string }> = {
  property_address: {
    label: 'Property address on file',
    description: 'Subject property address must be set before generating closing docs.',
  },
  parties_complete: {
    label: 'Parties complete',
    description: 'At least two parties (buyer + seller, or borrower + lender) on the file.',
  },
  required_docs_extracted: {
    label: 'Required documents extracted',
    description: 'Every doc this transaction type requires has run through extraction.',
  },
  no_open_blockers: {
    label: 'No open blockers',
    description: 'Every reconciliation finding tagged "block" is resolved or dismissed.',
  },
  wire_no_unresolved_alerts: {
    label: 'Wire instructions verified',
    description:
      'No unresolved wire-fraud alerts. Resolves automatically once wire findings are cleared.',
  },
  closing_disclosure_on_file: {
    label: 'Closing disclosure on file',
    description: 'A successfully extracted CD is required before disbursement.',
  },
  title_commitment_cleared: {
    label: 'Title commitment cleared',
    description: 'Commitment is on file and any prior liens have a release on record.',
  },
  cpl_issued: {
    label: 'CPL issued',
    description: 'Closing Protection Letter has been issued to the lender.',
  },
  funds_confirmed: {
    label: 'Funds confirmed in escrow',
    description: 'All incoming funds (buyer, lender) have settled in the escrow account.',
  },
  ids_verified: {
    label: 'Parties IDs verified',
    description: 'Government-issued ID inspected and notary log started.',
  },
  wire_phone_verified: {
    label: 'Outbound wire phone-verified',
    description:
      'Payee confirmed by phone using a number from a prior unrelated document.',
  },
  survey_reviewed: {
    label: 'Survey / plat reviewed',
    description: 'Survey or plat reviewed against legal description; no encroachments.',
  },
  lender_package_returned: {
    label: 'Lender package returned',
    description: 'Signed loan documents returned to the lender after closing.',
  },
}

export const isDerivedItem = (id: string): id is DerivedItem =>
  (DERIVED_ITEMS as ReadonlyArray<string>).includes(id)

// Inputs the readiness derivation needs. Loaded once per file and walked
// here rather than in N branching helpers so the cost is one round-trip
// per file in the listing.
type FileReadinessInputs = {
  file: Doc<'files'>
  partyCount: number
  documents: ReadonlyArray<Doc<'documents'>>
  extractions: ReadonlyArray<Doc<'documentExtractions'>>
  findings: ReadonlyArray<Doc<'reconciliationFindings'>>
  requiredDocTypes: ReadonlyArray<string>
  attestations: ReadonlyArray<{
    item: string
    attestedByMemberId: Id<'tenantMembers'>
    attestedAt: number
    note?: string
  }>
  memberEmailById: Map<Id<'tenantMembers'>, string>
}

function computeChecklist(inputs: FileReadinessInputs): ChecklistItem[] {
  const out: ChecklistItem[] = []
  const succeededByDoc = new Map<string, Doc<'documentExtractions'>>()
  for (const e of inputs.extractions) {
    if (e.status === 'succeeded') succeededByDoc.set(e.documentId, e)
  }
  const extractedDocTypes = new Set<string>()
  const extractedKinds = new Set<string>()
  for (const d of inputs.documents) {
    const e = succeededByDoc.get(d._id)
    if (e) {
      extractedDocTypes.add(d.docType)
      const kind = ((e.payload as { documentKind?: string } | undefined)
        ?.documentKind ?? '') as string
      if (kind) extractedKinds.add(kind)
    }
  }

  const openFindings = inputs.findings.filter((f) => f.status === 'open')
  const blockers = openFindings.filter((f) => f.severity === 'block')
  const wireAlerts = openFindings.filter((f) =>
    f.findingType.startsWith('wire.')
  )
  const openLien = openFindings.filter(
    (f) => f.findingType === 'open_lien_no_release'
  )

  const derived = (
    id: DerivedItem,
    pass: boolean,
    fallbackPending = false
  ): ChecklistItem => ({
    id,
    label: ITEM_LABELS[id].label,
    description: ITEM_LABELS[id].description,
    kind: 'derived',
    status: pass ? 'pass' : fallbackPending ? 'pending' : 'fail',
  })

  out.push(
    derived('property_address', !!inputs.file.propertyAddress?.line1)
  )
  out.push(derived('parties_complete', inputs.partyCount >= 2))

  const requiredOk =
    inputs.requiredDocTypes.length === 0 ||
    inputs.requiredDocTypes.every((t) => extractedDocTypes.has(t))
  out.push(derived('required_docs_extracted', requiredOk))

  out.push(derived('no_open_blockers', blockers.length === 0))

  out.push(derived('wire_no_unresolved_alerts', wireAlerts.length === 0))

  out.push(
    derived('closing_disclosure_on_file', extractedKinds.has('closing_disclosure'))
  )

  // Title-commitment-cleared = a commitment exists AND there are no
  // unmatched-lien findings. If the transaction is a refi without an
  // explicit commitment doc on file yet, this stays red — that's the
  // intended behavior; the operator should add the commitment.
  const hasCommitment = extractedKinds.has('commitment')
  out.push(
    derived(
      'title_commitment_cleared',
      hasCommitment && openLien.length === 0
    )
  )

  // Attestations.
  const attMap = new Map<string, FileReadinessInputs['attestations'][number]>()
  for (const a of inputs.attestations) attMap.set(a.item, a)
  for (const item of ATTEST_ITEMS) {
    const att = attMap.get(item)
    out.push({
      id: item,
      label: ITEM_LABELS[item].label,
      description: ITEM_LABELS[item].description,
      kind: 'attestation',
      status: att ? 'pass' : 'pending',
      note: att?.note,
      attestedByEmail: att
        ? inputs.memberEmailById.get(att.attestedByMemberId) ?? null
        : null,
      attestedAt: att?.attestedAt ?? null,
    })
  }

  return out
}

// ── Public queries ─────────────────────────────────────────────────────

const windowArg = v.union(
  v.literal('today'),
  v.literal('tomorrow'),
  v.literal('week'),
  v.literal('overdue')
)

function dayBoundsFor(window: 'today' | 'tomorrow' | 'week' | 'overdue'): {
  fromTs: number
  toTs: number
} {
  const now = new Date()
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).getTime()
  const oneDay = 24 * 60 * 60_000
  if (window === 'today') {
    return { fromTs: startOfToday, toTs: startOfToday + oneDay }
  }
  if (window === 'tomorrow') {
    return { fromTs: startOfToday + oneDay, toTs: startOfToday + 2 * oneDay }
  }
  if (window === 'week') {
    return { fromTs: startOfToday, toTs: startOfToday + 7 * oneDay }
  }
  // overdue: anything with a target close in the past, still active.
  return { fromTs: 0, toTs: startOfToday }
}

const ACTIVE_STATUSES = new Set(['opened', 'in_exam', 'cleared', 'closing'])

export const list = query({
  args: { window: v.optional(windowArg) },
  handler: async (ctx, { window }) => {
    const tc = await optionalTenant(ctx)
    if (!tc) return []
    const w = window ?? 'today'
    const { fromTs, toTs } = dayBoundsFor(w)

    // No (tenantId, targetCloseDate) index — by_tenant_openedAt orders by
    // opened time which we don't want. We pull recent active files (capped)
    // and filter in JS. A custom index on `targetCloseDate` is the right
    // long-term fix; for now bound at 500.
    const candidates = await ctx.db
      .query('files')
      .withIndex('by_tenant_openedAt', (q) => q.eq('tenantId', tc.tenantId))
      .order('desc')
      .take(500)
    const inWindow = candidates.filter((f) => {
      if (!ACTIVE_STATUSES.has(f.status)) return false
      const t = f.targetCloseDate
      if (typeof t !== 'number') return false
      return t >= fromTs && t < toTs
    })

    // Pre-load tenantMembers once so we can attribute attestations without
    // doing N+1 reads.
    const members = await ctx.db
      .query('tenantMembers')
      .withIndex('by_tenant_email', (q) => q.eq('tenantId', tc.tenantId))
      .take(200)
    const memberEmailById = new Map<Id<'tenantMembers'>, string>()
    for (const m of members) memberEmailById.set(m._id, m.email)

    // Cache transactionType → requiredDocs so we don't refetch per file.
    const txCache = new Map<string, ReadonlyArray<string>>()
    const loadRequiredDocs = async (
      code: string
    ): Promise<ReadonlyArray<string>> => {
      const hit = txCache.get(code)
      if (hit !== undefined) return hit
      const tt = await ctx.db
        .query('transactionTypes')
        .withIndex('by_code', (q) => q.eq('code', code))
        .unique()
      const docs = tt?.requiredDocs ?? []
      txCache.set(code, docs)
      return docs
    }

    const rows = await Promise.all(
      inWindow.map(async (file) => {
        const [parties, documents, extractions, findings, attestations, county] =
          await Promise.all([
            ctx.db
              .query('fileParties')
              .withIndex('by_tenant_file', (q) =>
                q.eq('tenantId', tc.tenantId).eq('fileId', file._id)
              )
              .take(50),
            ctx.db
              .query('documents')
              .withIndex('by_tenant_file', (q) =>
                q.eq('tenantId', tc.tenantId).eq('fileId', file._id)
              )
              .take(100),
            ctx.db
              .query('documentExtractions')
              .withIndex('by_tenant_file', (q) =>
                q.eq('tenantId', tc.tenantId).eq('fileId', file._id)
              )
              .take(100),
            ctx.db
              .query('reconciliationFindings')
              .withIndex('by_tenant_file', (q) =>
                q.eq('tenantId', tc.tenantId).eq('fileId', file._id)
              )
              .take(200),
            ctx.db
              .query('closingAttestations')
              .withIndex('by_tenant_file', (q) =>
                q.eq('tenantId', tc.tenantId).eq('fileId', file._id)
              )
              .take(50),
            ctx.db.get(file.countyId),
          ])
        const requiredDocTypes = await loadRequiredDocs(file.transactionType)
        const checklist = computeChecklist({
          file,
          partyCount: parties.length,
          documents,
          extractions,
          findings,
          requiredDocTypes,
          attestations,
          memberEmailById,
        })
        const passing = checklist.filter((i) => i.status === 'pass').length
        const total = checklist.length
        const blockers = checklist.filter((i) => i.status === 'fail').length
        const pendingAttestations = checklist.filter(
          (i) => i.kind === 'attestation' && i.status === 'pending'
        ).length

        return {
          fileId: file._id,
          fileNumber: file.fileNumber,
          status: file.status,
          transactionType: file.transactionType,
          targetCloseDate: file.targetCloseDate ?? null,
          propertyAddress: file.propertyAddress ?? null,
          countyName: county?.name ?? null,
          purchasePrice: file.purchasePrice ?? null,
          partyCount: parties.length,
          documentCount: documents.length,
          openFindings: findings.filter((f) => f.status === 'open').length,
          openBlockers: findings.filter(
            (f) => f.status === 'open' && f.severity === 'block'
          ).length,
          checklist,
          readiness: { passing, total, blockers, pendingAttestations },
        }
      })
    )

    // Surface earliest closing first; ties go to lowest readiness so the
    // riskiest file lands at the top of the day.
    rows.sort((a, b) => {
      const at = a.targetCloseDate ?? Number.POSITIVE_INFINITY
      const bt = b.targetCloseDate ?? Number.POSITIVE_INFINITY
      if (at !== bt) return at - bt
      return a.readiness.passing - b.readiness.passing
    })

    return rows
  },
})

// Aggregate stats for the page header — total files in each window and
// counts of any blockers.
export const summary = query({
  args: {},
  handler: async (ctx) => {
    const tc = await optionalTenant(ctx)
    if (!tc) {
      return { today: 0, tomorrow: 0, week: 0, overdue: 0, blockers: 0 }
    }
    const candidates = await ctx.db
      .query('files')
      .withIndex('by_tenant_openedAt', (q) => q.eq('tenantId', tc.tenantId))
      .order('desc')
      .take(500)
    const counts = { today: 0, tomorrow: 0, week: 0, overdue: 0, blockers: 0 }
    const tBounds = {
      today: dayBoundsFor('today'),
      tomorrow: dayBoundsFor('tomorrow'),
      week: dayBoundsFor('week'),
      overdue: dayBoundsFor('overdue'),
    }
    for (const f of candidates) {
      if (!ACTIVE_STATUSES.has(f.status)) continue
      const t = f.targetCloseDate
      if (typeof t !== 'number') continue
      if (t >= tBounds.today.fromTs && t < tBounds.today.toTs) counts.today++
      else if (t >= tBounds.tomorrow.fromTs && t < tBounds.tomorrow.toTs)
        counts.tomorrow++
      if (t >= tBounds.week.fromTs && t < tBounds.week.toTs) counts.week++
      if (t < tBounds.overdue.toTs) counts.overdue++
    }
    // Blockers across the week window.
    const weekFiles = candidates.filter(
      (f) =>
        ACTIVE_STATUSES.has(f.status) &&
        typeof f.targetCloseDate === 'number' &&
        f.targetCloseDate >= tBounds.week.fromTs &&
        f.targetCloseDate < tBounds.week.toTs
    )
    let blockers = 0
    for (const f of weekFiles) {
      const findings = await ctx.db
        .query('reconciliationFindings')
        .withIndex('by_tenant_file_status', (q) =>
          q.eq('tenantId', tc.tenantId).eq('fileId', f._id).eq('status', 'open')
        )
        .take(50)
      blockers += findings.filter((x) => x.severity === 'block').length
    }
    counts.blockers = blockers
    return counts
  },
})

// ── Mutations ──────────────────────────────────────────────────────────

export const attest = mutation({
  args: {
    fileId: v.id('files'),
    item: attestItem,
    note: v.optional(v.string()),
  },
  handler: async (ctx, { fileId, item, note }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    const file = await ctx.db.get(fileId)
    if (!file || file.tenantId !== tc.tenantId) {
      throw new ConvexError('FILE_NOT_FOUND')
    }

    const existing = await ctx.db
      .query('closingAttestations')
      .withIndex('by_tenant_file_item', (q) =>
        q.eq('tenantId', tc.tenantId).eq('fileId', fileId).eq('item', item)
      )
      .unique()

    const now = Date.now()
    const trimmedNote = note?.trim() ? note.trim() : undefined

    let id: Id<'closingAttestations'>
    if (existing) {
      await ctx.db.patch(existing._id, {
        attestedByMemberId: tc.memberId,
        attestedAt: now,
        note: trimmedNote,
      })
      id = existing._id
    } else {
      id = await ctx.db.insert('closingAttestations', {
        tenantId: tc.tenantId,
        fileId,
        item,
        attestedByMemberId: tc.memberId,
        attestedAt: now,
        note: trimmedNote,
      })
    }

    await recordAudit(ctx, tc, 'closing.attested', 'file', fileId, {
      item,
      note: trimmedNote,
    })
    return { ok: true, attestationId: id }
  },
})

export const unattest = mutation({
  args: {
    fileId: v.id('files'),
    item: attestItem,
  },
  handler: async (ctx, { fileId, item }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    const file = await ctx.db.get(fileId)
    if (!file || file.tenantId !== tc.tenantId) {
      throw new ConvexError('FILE_NOT_FOUND')
    }
    const existing = await ctx.db
      .query('closingAttestations')
      .withIndex('by_tenant_file_item', (q) =>
        q.eq('tenantId', tc.tenantId).eq('fileId', fileId).eq('item', item)
      )
      .unique()
    if (!existing) return { ok: true, removed: false }
    await ctx.db.delete(existing._id)
    await recordAudit(ctx, tc, 'closing.unattested', 'file', fileId, { item })
    return { ok: true, removed: true }
  },
})
