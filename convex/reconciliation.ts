import { ConvexError, v } from 'convex/values'
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import type { MutationCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { requireRole, requireTenant, type TenantContext } from './lib/tenant'
import { recordAudit } from './lib/audit'
import {
  getCatalogEntry,
  loadPolicyMap,
  loadRequiredDocsByCode,
  loadTolerances,
  resolveSeverity,
  type Tolerances,
} from './lib/reconciliationPolicy'
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
  wireInstructions?: {
    payeeName?: string
    payeeBankName?: string
    beneficiaryName?: string
    amount?: number
    instructionDate?: string
    wireType?: string
    senderRole?: string
  } | null
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

// Wire-instruction verification (ALTA Pillar 2 — escrow/funding controls).
//
// Wire-fraud in title closings almost always presents the same way: an
// instruction sheet arrives by email purporting to be from the title
// company / seller / lender, names a "new" payee, and routes funds to
// an attacker's account. Catching it requires linking the wire's payee
// name back to entities the file already knows about.
//
// What this rule does:
//   1. For each `wire_instructions` extraction, compute token-overlap
//      between its payeeName and every entity name we already see on the
//      file — file-parties' legalNames + any extracted titleCompany.name.
//   2. No tokens shared with anyone → BLOCK ("wire.payee_unknown").
//      The payee is not an entity any prior document mentions; treat as
//      probable fraud until a human signs off.
//   3. Partial match (≥1 token shared, but not a full subset of any
//      single entity) → WARN ("wire.payee_partial_match"). Could be a
//      legitimate variant ("Near North Title" vs "Near North Title
//      Insurance Co") or a typo-squatting attempt.
//   4. Full match → no finding emitted (clean signal — info noise).
//
// Amount sanity: if the wire amount is absurd vs. the contract price
// (>1.5x or <0.1x), surface a WARN. This catches both decimal-shift
// errors and "wrong file" attacks.
//
// What this rule deliberately does NOT do (yet):
//   • Routing/account number comparison — those are NPI; the prompt
//     refuses to extract them.
//   • Sender-domain reputation — needs the inbound email row threaded
//     through, which the reconciliation engine doesn't see today.
//   • Historical "this payee changed banks" — needs a wireFindings
//     history table that we'll add when the second slice ships.

const WIRE_NAME_STOPWORDS = new Set([
  'the',
  'of',
  'and',
  'a',
  'an',
  'co',
  'company',
  'llc',
  'l.l.c',
  'lp',
  'l.p',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'pllc',
  'group',
  'services',
  'service',
  'escrow',
  'account',
  'trust',
])

function nameTokens(s: string | undefined): Set<string> {
  if (!s) return new Set()
  const norm = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return new Set(
    norm
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !WIRE_NAME_STOPWORDS.has(t))
  )
}

// Returns the highest match score (0..1) of `payee` against any of the
// candidate entity names, plus the candidate that won. 1.0 means every
// significant payee token appears in the candidate's tokens.
function bestNameMatch(
  payee: string,
  candidates: ReadonlyArray<{ name: string; from: string }>
): { score: number; against: { name: string; from: string } | null } {
  const payeeTokens = nameTokens(payee)
  if (payeeTokens.size === 0 || candidates.length === 0) {
    return { score: 0, against: null }
  }
  let best: { score: number; against: { name: string; from: string } | null } =
    { score: 0, against: null }
  for (const c of candidates) {
    const candTokens = nameTokens(c.name)
    if (candTokens.size === 0) continue
    let hit = 0
    for (const t of payeeTokens) if (candTokens.has(t)) hit++
    const score = hit / payeeTokens.size
    if (score > best.score) best = { score, against: c }
  }
  return best
}

function verifyWireInstructions(
  extractions: Array<{
    documentId: Id<'documents'>
    view: ExtractionView
    uploadedAt: number
  }>,
  out: Pending[],
  tolerances: Tolerances
) {
  const wires = extractions.filter(
    (e) =>
      e.view.documentKind === 'wire_instructions' &&
      e.view.wireInstructions != null
  )
  if (wires.length === 0) return

  // Build the universe of "known good" entity names from every other
  // extraction on the file. We deliberately don't restrict by role —
  // payees can legitimately be the seller, the title co., a 1031
  // exchange intermediary, or a contractor named in the PA notes.
  const candidates: Array<{ name: string; from: string }> = []
  for (const e of extractions) {
    if (e.view.documentKind === 'wire_instructions') continue
    for (const p of e.view.parties ?? []) {
      if (p.legalName) {
        candidates.push({
          name: p.legalName,
          from: `${e.view.documentKind ?? 'doc'}.parties[${p.role ?? '?'}]`,
        })
      }
    }
    if (e.view.titleCompany?.name) {
      candidates.push({
        name: e.view.titleCompany.name,
        from: `${e.view.documentKind ?? 'doc'}.titleCompany`,
      })
    }
  }

  const latestPrice = pickLatestPrice(extractions)?.price ?? null

  for (const wire of wires) {
    const wi = wire.view.wireInstructions!
    const payee = wi.payeeName
    if (!payee) {
      out.push({
        findingType: 'wire.payee_missing',
        severity: 'warn',
        message:
          'Wire instructions are present but no payee name was extracted. Confirm the instructions are legible and contain a payee.',
        involvedDocumentIds: [wire.documentId],
        involvedFields: ['wireInstructions.payeeName'],
        rawDetail: { wireInstructions: wi },
      })
      continue
    }

    const best = bestNameMatch(payee, candidates)
    if (best.score === 0) {
      out.push({
        findingType: 'wire.payee_unknown',
        severity: 'block',
        message: `Wire payee "${payee}" does not match any party or title company on this file. Treat as potential wire fraud — confirm by phone with a known number from a prior unrelated document before releasing funds.`,
        involvedDocumentIds: [wire.documentId],
        involvedFields: [
          'wireInstructions.payeeName',
          'parties.legalName',
          'titleCompany.name',
        ],
        rawDetail: {
          payee,
          payeeBank: wi.payeeBankName,
          knownEntities: candidates.map((c) => c.name),
        },
      })
    } else if (best.score < 1) {
      out.push({
        findingType: 'wire.payee_partial_match',
        severity: 'warn',
        message: `Wire payee "${payee}" partially matches "${best.against?.name ?? '?'}" (${Math.round(best.score * 100)}% token overlap). Verify by phone before releasing — wire-fraud often presents as a near-twin of the real payee.`,
        involvedDocumentIds: [wire.documentId],
        involvedFields: [
          'wireInstructions.payeeName',
          'parties.legalName',
          'titleCompany.name',
        ],
        rawDetail: {
          payee,
          payeeBank: wi.payeeBankName,
          bestMatch: best.against,
          score: best.score,
        },
      })
    }

    // Amount sanity vs. the contract price. Only fires when both are
    // known — silent on closing-cost-only wires (which legitimately fall
    // far below price), since those would false-positive every time.
    if (latestPrice !== null && typeof wi.amount === 'number') {
      const ratio = wi.amount / latestPrice
      if (ratio >= tolerances.wireAmountRedFlagRatio) {
        out.push({
          findingType: 'wire.amount_unusual',
          severity: 'warn',
          message: `Wire amount $${wi.amount.toLocaleString()} is ${ratio.toFixed(1)}× the agreed purchase price ($${latestPrice.toLocaleString()}). Confirm — common decimal-shift fraud.`,
          involvedDocumentIds: [wire.documentId],
          involvedFields: ['wireInstructions.amount', 'financial.purchasePrice'],
          rawDetail: {
            amount: wi.amount,
            purchasePrice: latestPrice,
            ratio,
          },
        })
      }
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

// ─── County-records comparators ────────────────────────────────────────
// Each takes the latest propertySnapshot and compares it against the file
// (or the cross-document extraction set). All return early when the
// relevant snapshot field is null/empty so partial ATTOM responses don't
// generate spurious findings.

function compareOwnerOfRecord(
  extractions: Array<{
    documentId: Id<'documents'>
    view: ExtractionView
    uploadedAt: number
  }>,
  snapshot: Doc<'propertySnapshots'>,
  out: Pending[]
) {
  const ownerName = snapshot.property?.owner.name
  if (!ownerName) return
  const ownerCanonical = normalizeLegalName(ownerName).canonical

  type SellerHit = {
    documentId: Id<'documents'>
    documentKind?: string
    legalName: string
  }
  const sellers: SellerHit[] = []
  for (const e of extractions) {
    for (const p of e.view.parties ?? []) {
      if (!p.legalName) continue
      const role = (p.role ?? '').toLowerCase()
      if (role === 'seller' || role === 'grantor') {
        sellers.push({
          documentId: e.documentId,
          documentKind: e.view.documentKind,
          legalName: p.legalName,
        })
      }
    }
  }
  if (sellers.length === 0) return

  const matches = sellers.some(
    (s) => normalizeLegalName(s.legalName).canonical === ownerCanonical
  )
  if (matches) return

  out.push({
    findingType: 'owner_of_record_mismatch',
    // Warn (not block) — county data legitimately lags real transfers in
    // probate, divorce, and recent-sale cases. The processor reviews,
    // confirms via independent search, and acknowledges or escalates.
    severity: 'warn',
    message: `County records show ${ownerName} as the current owner of record, but the file names ${sellers[0]!.legalName} as seller. Confirm the chain of title — there may be an unrecorded transfer, name change, or stale county data.`,
    involvedDocumentIds: sellers.map((s) => s.documentId),
    involvedFields: ['parties.legalName'],
    rawDetail: {
      ownerOfRecord: ownerName,
      sellersInFile: sellers.map((s) => s.legalName),
      provider: snapshot.provider,
      fetchedAt: snapshot.fetchedAt,
    },
  })
}

function compareApn(
  file: Doc<'files'>,
  snapshot: Doc<'propertySnapshots'>,
  out: Pending[]
) {
  const fileApn = (file.propertyApn ?? '').trim()
  const snapApn = (snapshot.property?.apn ?? '').trim()
  if (!fileApn || !snapApn) return
  // Strip non-alphanumerics so format differences don't fire a false
  // positive (e.g. "49-15-17-124-083.000-500" vs "491517124083000500").
  const stripped = (s: string) => s.replace(/[^A-Z0-9]/gi, '').toUpperCase()
  if (stripped(fileApn) === stripped(snapApn)) return

  out.push({
    findingType: 'parcel_apn_mismatch',
    severity: 'warn',
    message: `Parcel on file (${fileApn}) doesn't match the parcel ATTOM returned (${snapApn}). The address may have resolved to the wrong parcel — verify before relying on the chain or tax data.`,
    involvedDocumentIds: [],
    involvedFields: ['propertyApn'],
    rawDetail: {
      fileApn,
      snapshotApn: snapApn,
      provider: snapshot.provider,
    },
  })
}

// Pairs each lien (mortgage / deed of trust) to a release recorded later
// where the lender (grantee on the lien) appears as the grantor on the
// release. FIFO so an older lien claims an older release. A lien left
// unpaired is reported. More accurate than counting because real chains
// often span decades with multiple unrelated lenders.
function flagOpenLiens(
  snapshot: Doc<'propertySnapshots'>,
  out: Pending[]
) {
  const docs = snapshot.documents ?? []
  if (docs.length === 0) return

  const isLien = (t: string) =>
    /\b(mortgage|deed of trust|lien|security instrument)\b/i.test(t) &&
    !/\b(release|satisfaction|reconvey)\b/i.test(t)
  const isRelease = (t: string) =>
    /\b(release|satisfaction|reconvey)\b/i.test(t)

  type Recorded = (typeof docs)[number]
  const liens = docs.filter((d) => isLien(d.documentType))
  if (liens.length === 0) return

  // Sort ascending so older liens match older releases first.
  const cmp = (a: Recorded, b: Recorded) => {
    const da = a.recordingDate ?? '9999-99-99'
    const db = b.recordingDate ?? '9999-99-99'
    return da < db ? -1 : da > db ? 1 : 0
  }
  const sortedLiens = [...liens].sort(cmp)
  const remainingReleases = docs.filter((d) => isRelease(d.documentType)).sort(cmp)

  // Lender-name normalization: drop common entity suffixes and the word
  // "BANK" so "Old National Bank, NA" matches "OLD NATIONAL".
  const normLender = (s: string | null) =>
    (s ?? '')
      .toUpperCase()
      .replace(/[,.&]/g, ' ')
      .replace(/\b(LLC|INC|CORP|CO|N\.A\.|NA|BANK|TRUST|LP|LLP)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim()

  const unmatched: Recorded[] = []
  for (const lien of sortedLiens) {
    const lender = normLender(lien.grantee)
    if (!lender) {
      unmatched.push(lien)
      continue
    }
    const idx = remainingReleases.findIndex((r) => {
      if (normLender(r.grantor) !== lender) return false
      if (
        lien.recordingDate &&
        r.recordingDate &&
        r.recordingDate < lien.recordingDate
      ) {
        return false
      }
      return true
    })
    if (idx >= 0) {
      remainingReleases.splice(idx, 1)
    } else {
      unmatched.push(lien)
    }
  }

  if (unmatched.length === 0) return

  const open = unmatched.length
  out.push({
    findingType: 'open_lien_no_release',
    severity: 'warn',
    message: `${open} recorded lien${open === 1 ? '' : 's'} on this parcel ${open === 1 ? 'has' : 'have'} no matching release in the chain. Confirm payoff and recorded satisfaction before closing.`,
    involvedDocumentIds: [],
    involvedFields: [],
    rawDetail: {
      unmatched: unmatched.map((d) => ({
        recordingDate: d.recordingDate,
        documentNumber: d.documentNumber,
        grantor: d.grantor,
        grantee: d.grantee,
        amount: d.amount,
      })),
      lienCount: liens.length,
      pairedReleases: liens.length - unmatched.length,
      provider: snapshot.provider,
    },
  })
}

function flagSalePriceVariance(
  extractions: Array<{
    documentId: Id<'documents'>
    view: ExtractionView
    uploadedAt: number
  }>,
  snapshot: Doc<'propertySnapshots'>,
  out: Pending[],
  tolerances: Tolerances
) {
  const market = snapshot.tax?.marketValue
  if (market === null || market === undefined || market <= 0) return
  const latest = pickLatestPrice(extractions)
  if (!latest) return
  const ratio = latest.price / market
  const { salePriceVarianceLow: lo, salePriceVarianceHigh: hi } = tolerances
  // Owner-tunable band. Defaults to [0.6, 1.4] (±40%) which suits flip-heavy
  // and non-disclosure markets; tighten for steady-state retail.
  if (ratio >= lo && ratio <= hi) return

  const direction = ratio < lo ? 'below' : 'above'
  const pct = Math.round(Math.abs(ratio - 1) * 100)
  out.push({
    findingType: 'sale_price_variance_market',
    severity: 'info',
    message: `Contract price ($${latest.price.toLocaleString()}) is ${pct}% ${direction} the county market value ($${market.toLocaleString()}). Common for distressed / family / portfolio transfers — confirm transaction type.`,
    involvedDocumentIds: [latest.documentId],
    involvedFields: ['financial.purchasePrice'],
    rawDetail: {
      contractPrice: latest.price,
      marketValue: market,
      ratio,
      direction,
      provider: snapshot.provider,
    },
  })
}

function checkRequiredDocs(
  file: Doc<'files'>,
  uploadedDocTypes: Set<string>,
  requiredDocsByCode: ReadonlyMap<string, ReadonlyArray<string>>,
  out: Pending[]
): void {
  const required = requiredDocsByCode.get(file.transactionType)
  if (!required) return
  const missing = required.filter((d) => !uploadedDocTypes.has(d))
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

  const tolerances = await loadTolerances(ctx, tenantId)

  const findings: Pending[] = []
  comparePrices(usable, findings)
  compareTitleCompany(usable, findings)
  compareEarnestMoney(usable, findings)
  compareClosingDate(usable, findings)
  compareFinancingWindow(usable, findings)
  compareParties(usable, findings)
  compareVesting(usable, findings)
  verifyWireInstructions(usable, findings, tolerances)

  // County-records evidence (from the latest propertySnapshot, populated by
  // countyConnect.runForFile). All four checks no-op when no snapshot exists,
  // so files without a county pull reconcile exactly as before.
  const snapshot = await ctx.db
    .query('propertySnapshots')
    .withIndex('by_tenant_file_fetched', (q) =>
      q.eq('tenantId', tenantId).eq('fileId', fileId)
    )
    .order('desc')
    .first()
  if (snapshot) {
    compareOwnerOfRecord(usable, snapshot, findings)
    compareApn(file, snapshot, findings)
    flagOpenLiens(snapshot, findings)
    flagSalePriceVariance(usable, snapshot, findings, tolerances)
  }

  const uploadedDocTypes = new Set(usable.map((e) => e.docType))
  const requiredDocsByCode = await loadRequiredDocsByCode(ctx, tenantId)
  checkRequiredDocs(file, uploadedDocTypes, requiredDocsByCode, findings)

  // Apply the per-tenant policy. Unknown finding types (not in the catalog)
  // pass through unchanged so the reconciler can ship new checks without
  // waiting on a catalog migration. `severity: "off"` drops the finding.
  const policy = await loadPolicyMap(ctx, tenantId)
  const policed: Pending[] = []
  for (const f of findings) {
    const catalog = getCatalogEntry(f.findingType)
    if (!catalog) {
      policed.push(f)
      continue
    }
    const next = resolveSeverity(f.findingType, catalog.defaultSeverity, policy)
    if (next === null) continue
    policed.push(next === f.severity ? f : { ...f, severity: next })
  }

  // The user-triggered path uses the existing "wipe open then re-create"
  // policy. The auto path uses the same policy by passing the tenant id
  // through a thin shim.
  const removed = await clearOpenFindings(ctx, tenantId, fileId)

  const now = Date.now()
  const insertedIds: Array<Id<'reconciliationFindings'>> = []
  for (const f of policed) {
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
    info: policed.filter((f) => f.severity === 'info').length,
    warn: policed.filter((f) => f.severity === 'warn').length,
    block: policed.filter((f) => f.severity === 'block').length,
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

// ── AI risk explainer ──────────────────────────────────────────────────
// `requestExplanation` schedules the Node-side findingExplainer action,
// which calls Claude and writes back via `_applyExplanation`. We split the
// query/mutation here from the action (in convex/findingExplainer.ts) so
// the V8 + Node runtime boundary stays clean.

export const _loadExplainerContext = internalQuery({
  args: { findingId: v.id('reconciliationFindings') },
  handler: async (ctx, { findingId }) => {
    const finding = await ctx.db.get(findingId)
    if (!finding) return null
    const file = await ctx.db.get(finding.fileId)
    if (!file) return null

    // Pull involved-document extractions so the prompt has the actual
    // values that diverged. Bounded so a runaway finding can't drag in
    // hundreds of docs.
    const docViews: Array<{
      documentId: string
      docType: string
      title: string | null
      kind: string | null
      summary: string | null
    }> = []
    for (const docId of finding.involvedDocumentIds.slice(0, 8)) {
      const doc = await ctx.db.get(docId)
      if (!doc) continue
      const ext = await ctx.db
        .query('documentExtractions')
        .withIndex('by_tenant_document', (q) =>
          q.eq('tenantId', finding.tenantId).eq('documentId', docId)
        )
        .unique()
      const payload = ext?.payload as
        | { documentKind?: string }
        | null
        | undefined
      docViews.push({
        documentId: docId,
        docType: doc.docType,
        title: doc.title ?? null,
        kind: payload?.documentKind ?? null,
        summary: ext ? summarizeExtraction(ext.payload) : null,
      })
    }

    // Other open findings on the same file — gives the model context like
    // "there's also a wire alert here" so the explanation can connect dots.
    const peerFindings = await ctx.db
      .query('reconciliationFindings')
      .withIndex('by_tenant_file_status', (q) =>
        q
          .eq('tenantId', finding.tenantId)
          .eq('fileId', finding.fileId)
          .eq('status', 'open')
      )
      .take(15)

    return {
      finding: {
        _id: finding._id,
        findingType: finding.findingType,
        severity: finding.severity,
        message: finding.message,
        involvedFields: finding.involvedFields,
        rawDetail: finding.rawDetail,
      },
      file: {
        fileNumber: file.fileNumber,
        transactionType: file.transactionType,
        propertyAddress: file.propertyAddress ?? null,
        purchasePrice: file.purchasePrice ?? null,
      },
      docViews,
      peers: peerFindings
        .filter((p) => p._id !== finding._id)
        .map((p) => ({
          findingType: p.findingType,
          severity: p.severity,
          message: p.message,
        })),
    }
  },
})

function summarizeExtraction(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const parts: string[] = []
  if (p.documentKind) parts.push(`kind=${p.documentKind}`)
  const fin = p.financial as Record<string, unknown> | undefined
  if (fin?.purchasePrice !== undefined) {
    parts.push(`price=$${(fin.purchasePrice as number).toLocaleString()}`)
  }
  const dates = p.dates as Record<string, unknown> | undefined
  if (dates?.closingDate) parts.push(`closing=${dates.closingDate}`)
  const tc = p.titleCompany as Record<string, unknown> | undefined
  if (tc?.name) parts.push(`title=${tc.name}`)
  const wi = p.wireInstructions as Record<string, unknown> | undefined
  if (wi?.payeeName) parts.push(`wire→${wi.payeeName}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

export const _applyExplanation = internalMutation({
  args: {
    findingId: v.id('reconciliationFindings'),
    why: v.string(),
    next: v.string(),
    modelId: v.optional(v.string()),
  },
  handler: async (ctx, { findingId, why, next, modelId }) => {
    const finding = await ctx.db.get(findingId)
    if (!finding) return
    await ctx.db.patch(findingId, {
      aiSummary: {
        why: why.trim().slice(0, 800),
        next: next.trim().slice(0, 800),
        generatedAt: Date.now(),
        modelId,
      },
    })
  },
})

// Public: editor schedules the explainer. Audited so we know which
// findings actually got AI review on a deployment.
export const requestExplanation = mutation({
  args: { findingId: v.id('reconciliationFindings') },
  handler: async (ctx, { findingId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    const finding = await ctx.db.get(findingId)
    if (!finding || finding.tenantId !== tc.tenantId) {
      throw new ConvexError('FINDING_NOT_FOUND')
    }
    await ctx.scheduler.runAfter(0, internal.findingExplainer.explain, {
      findingId,
    })
    await recordAudit(ctx, tc, 'finding.explanation_requested', 'file', finding.fileId, {
      findingId,
    })
    return { ok: true }
  },
})

// Assign a finding to a teammate. Pass `assigneeMemberId: null` (omitted)
// to clear the owner. The new assignee gets a per-member notification so
// the bell + queue surface the new work.
export const assignFinding = mutation({
  args: {
    findingId: v.id('reconciliationFindings'),
    assigneeMemberId: v.optional(v.id('tenantMembers')),
  },
  handler: async (ctx, { findingId, assigneeMemberId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    const finding = await ctx.db.get(findingId)
    if (!finding || finding.tenantId !== tc.tenantId) {
      throw new ConvexError('FINDING_NOT_FOUND')
    }
    if (assigneeMemberId) {
      const m = await ctx.db.get(assigneeMemberId)
      if (!m || m.tenantId !== tc.tenantId || m.status !== 'active') {
        throw new ConvexError('ASSIGNEE_INVALID')
      }
    }
    await ctx.db.patch(findingId, { assigneeMemberId })

    await recordAudit(ctx, tc, 'finding.assigned', 'file', finding.fileId, {
      findingId,
      from: finding.assigneeMemberId ?? null,
      to: assigneeMemberId ?? null,
    })

    // Notify the new assignee directly — single-member, not the full
    // fan-out — so the queue lights up for them and them alone.
    if (assigneeMemberId && assigneeMemberId !== tc.memberId) {
      const file = await ctx.db.get(finding.fileId)
      await ctx.db.insert('notifications', {
        tenantId: tc.tenantId,
        memberId: assigneeMemberId,
        kind: 'finding.assigned',
        title: `Assigned: ${finding.findingType.replace(/_/g, ' ')}`,
        body: file
          ? `On ${file.fileNumber} · ${finding.message}`
          : finding.message,
        severity:
          finding.severity === 'block'
            ? 'block'
            : finding.severity === 'warn'
              ? 'warn'
              : 'info',
        fileId: finding.fileId,
        groupKey: `finding.assigned:${finding.fileId}:${assigneeMemberId}`,
        actorMemberId: tc.memberId,
        actorType: 'user',
        occurredAt: Date.now(),
      })
    }

    return { ok: true }
  },
})

// One-click verification path for non-factable findings (wire, vesting,
// owner-of-record, open-lien, etc). Unlike `resolveWith`, this mutation does
// NOT promote a document's value to ground truth — it records that a human
// verified the issue out of band and explains how. The resolvedValue payload
// captures method + note for auditability.
//
// Examples of `evidence.method`:
//   "phone_call"      — wire payee confirmed by phone with a known contact
//   "independent"     — independent verification (different channel)
//   "recording_search"— chain of title verified via county recorder search
//   "payoff_on_file"  — payoff letters/satisfactions confirmed in file
//   "in_person"       — confirmed face-to-face at closing
//   "other"           — free-form note required
export const verifyFinding = mutation({
  args: {
    findingId: v.id('reconciliationFindings'),
    method: v.union(
      v.literal('phone_call'),
      v.literal('independent'),
      v.literal('recording_search'),
      v.literal('payoff_on_file'),
      v.literal('in_person'),
      v.literal('other')
    ),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { findingId, method, note }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    const finding = await ctx.db.get(findingId)
    if (!finding || finding.tenantId !== tc.tenantId) {
      throw new ConvexError('FINDING_NOT_FOUND')
    }
    const now = Date.now()
    const verified = {
      kind: 'verified_by_human' as const,
      method,
      note: note?.trim() || undefined,
      verifiedAt: now,
      verifiedByMemberId: tc.memberId,
    }
    await ctx.db.patch(findingId, {
      status: 'resolved',
      resolvedByMemberId: tc.memberId,
      resolvedAt: now,
      resolvedValue: verified,
    })
    await recordAudit(ctx, tc, 'finding.verified', 'file', finding.fileId, {
      findingId,
      findingType: finding.findingType,
      method,
      note: verified.note,
      from: finding.status,
    })
    await ctx.runMutation(internal.webhooks.enqueue, {
      tenantId: tc.tenantId,
      event: 'finding.resolved',
      payload: {
        findingId,
        fileId: finding.fileId,
        findingType: finding.findingType,
        verification: verified,
      },
    })
    return { ok: true, verification: verified }
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
