// Reconciliation policy catalog + per-tenant override resolver.
//
// The catalog is the source of truth for every finding type the reconciler
// can emit. Each entry carries a default severity, a human-readable label,
// and a short description so the admin UI can render them without separate
// translation files. Adding a new finding type = adding a row here +
// referencing it from reconciliation.ts.
//
// Tenant overrides live in the `tenantReconciliationPolicies` table. The
// `loadPolicyMap` helper reads them once at the top of a reconciliation
// run; resolveSeverity then folds the override against the catalog default
// for each finding the reconciler is about to emit. `severity: "off"`
// suppresses the finding entirely.

import type { QueryCtx } from '../_generated/server'
import type { Id } from '../_generated/dataModel'

export type Severity = 'info' | 'warn' | 'block'
export type PolicySeverity = Severity | 'off'

export type FindingCategory =
  | 'price'
  | 'parties'
  | 'property'
  | 'closing'
  | 'wire'
  | 'documents'

export type FindingCatalogEntry = {
  /** Stable identifier emitted on `findings.findingType`. */
  type: string
  /** Short human-readable label for the admin UI. */
  label: string
  /** One-sentence explanation of when the finding fires. */
  description: string
  /** Default severity used when the tenant has no override. */
  defaultSeverity: Severity
  /** Grouping for the UI. */
  category: FindingCategory
}

// IMPORTANT: when reconciliation.ts emits a finding type, it must appear
// here. The admin UI iterates over this catalog to render the policy
// table — anything missing here is invisible to owners.
export const FINDING_CATALOG: ReadonlyArray<FindingCatalogEntry> = [
  // ── Price ───────────────────────────────────────────────────────
  {
    type: 'price_mismatch',
    label: 'Price mismatch',
    description:
      'The latest authoritative purchase agreement disagrees with the price on another document.',
    defaultSeverity: 'block',
    category: 'price',
  },
  {
    type: 'price_amended',
    label: 'Price amended by counter-offer',
    description:
      'A counter-offer supersedes the purchase agreement price. Surfaced for confirmation, not blocking.',
    defaultSeverity: 'warn',
    category: 'price',
  },
  {
    type: 'sale_price_variance_market',
    label: 'Sale price varies from market',
    description:
      'Purchase price is materially above or below the market estimate from County Connect.',
    defaultSeverity: 'info',
    category: 'price',
  },
  // ── Parties ─────────────────────────────────────────────────────
  {
    type: 'party_name_mismatch',
    label: 'Party name mismatch',
    description:
      'A party name on a document differs from the canonical name on the file.',
    defaultSeverity: 'warn',
    category: 'parties',
  },
  {
    type: 'party_capacity_mismatch',
    label: 'Party signing capacity mismatch',
    description:
      'A party signed in a capacity (trustee, executor, attorney-in-fact) inconsistent with their role on the file.',
    defaultSeverity: 'block',
    category: 'parties',
  },
  {
    type: 'trust_without_trustee',
    label: 'Trust without trustee',
    description: 'A trust is named as a party but no trustee has been identified.',
    defaultSeverity: 'block',
    category: 'parties',
  },
  {
    type: 'estate_without_executor',
    label: 'Estate without executor',
    description: 'An estate is named as a party but no executor has been identified.',
    defaultSeverity: 'block',
    category: 'parties',
  },
  {
    type: 'joint_vesting_unclear',
    label: 'Joint vesting unclear',
    description:
      'Multiple grantees are named without explicit JTWROS / TIC / TBE vesting language.',
    defaultSeverity: 'warn',
    category: 'parties',
  },
  {
    type: 'poa_present',
    label: 'Power of attorney present',
    description:
      'A POA was detected on a signing document; verify recording requirements with the recorder.',
    defaultSeverity: 'warn',
    category: 'parties',
  },
  {
    type: 'decedent_indicator',
    label: 'Decedent indicator on a party',
    description:
      'A document references a deceased party. Confirm the chain of title before recording.',
    defaultSeverity: 'warn',
    category: 'parties',
  },
  // ── Property ───────────────────────────────────────────────────
  {
    type: 'owner_of_record_mismatch',
    label: 'Owner of record mismatch',
    description:
      'The current owner of record from County Connect differs from the seller on the file.',
    defaultSeverity: 'warn',
    category: 'property',
  },
  {
    type: 'parcel_apn_mismatch',
    label: 'APN / parcel mismatch',
    description:
      'The APN on a document disagrees with the APN attached to the file.',
    defaultSeverity: 'warn',
    category: 'property',
  },
  {
    type: 'open_lien_no_release',
    label: 'Open lien without release',
    description:
      'County Connect shows an open lien with no recorded release.',
    defaultSeverity: 'warn',
    category: 'property',
  },
  // ── Closing terms ──────────────────────────────────────────────
  {
    type: 'closing_date_mismatch',
    label: 'Closing date mismatch',
    description:
      'Closing date differs across documents (purchase agreement vs. settlement statement, etc.).',
    defaultSeverity: 'warn',
    category: 'closing',
  },
  {
    type: 'earnest_money_refundability_change',
    label: 'Earnest money refundability change',
    description:
      'Earnest money refundability flipped between documents — high-risk change.',
    defaultSeverity: 'block',
    category: 'closing',
  },
  {
    type: 'financing_window_change',
    label: 'Financing approval window change',
    description: 'Financing-contingency window changed between documents.',
    defaultSeverity: 'warn',
    category: 'closing',
  },
  {
    type: 'title_company_change',
    label: 'Title company change',
    description: 'The title company named on the file changed between documents.',
    defaultSeverity: 'warn',
    category: 'closing',
  },
  {
    type: 'title_company_set',
    label: 'Title company first set',
    description: 'A title company was attached to a file for the first time.',
    defaultSeverity: 'info',
    category: 'closing',
  },
  // ── Wire instructions ─────────────────────────────────────────
  {
    type: 'wire.payee_missing',
    label: 'Wire payee missing',
    description: 'A wire instruction was received without a named payee.',
    defaultSeverity: 'warn',
    category: 'wire',
  },
  {
    type: 'wire.payee_unknown',
    label: 'Wire payee unknown to file',
    description:
      'The wire payee does not match any party on the file — possible fraud signal.',
    defaultSeverity: 'block',
    category: 'wire',
  },
  {
    type: 'wire.payee_partial_match',
    label: 'Wire payee partial match',
    description:
      'The wire payee partially matches a party on the file (e.g. a single token off).',
    defaultSeverity: 'warn',
    category: 'wire',
  },
  {
    type: 'wire.amount_unusual',
    label: 'Wire amount unusual',
    description:
      'The wire amount is materially outside the file’s purchase price band.',
    defaultSeverity: 'warn',
    category: 'wire',
  },
  // ── Documents ─────────────────────────────────────────────────
  {
    type: 'missing_required_documents',
    label: 'Missing required documents',
    description:
      'The file is missing one or more documents required for its transaction type.',
    defaultSeverity: 'warn',
    category: 'documents',
  },
] as const

const catalogByType = new Map<string, FindingCatalogEntry>(
  FINDING_CATALOG.map((entry) => [entry.type, entry])
)

export function getCatalogEntry(
  type: string
): FindingCatalogEntry | undefined {
  return catalogByType.get(type)
}

export type PolicyMap = ReadonlyMap<string, PolicySeverity>

/**
 * Load all per-tenant overrides into a Map keyed by findingType. Read once
 * at the top of a reconciliation run — every subsequent severity decision
 * resolves against this in-memory map without further database hits.
 */
export async function loadPolicyMap(
  ctx: QueryCtx,
  tenantId: Id<'tenants'>
): Promise<PolicyMap> {
  const rows = await ctx.db
    .query('tenantReconciliationPolicies')
    .withIndex('by_tenant', (q) => q.eq('tenantId', tenantId))
    .collect()
  const out = new Map<string, PolicySeverity>()
  for (const row of rows) out.set(row.findingType, row.severity)
  return out
}

/**
 * Resolve the effective severity for a finding type. Returns `null` when
 * the finding is suppressed (`severity: "off"`) — callers must check for
 * null and skip emitting the finding.
 */
export function resolveSeverity(
  type: string,
  defaultSeverity: Severity,
  policy: PolicyMap
): Severity | null {
  const override = policy.get(type)
  if (override === 'off') return null
  if (override === undefined) return defaultSeverity
  return override
}

// ─────────────────────────────────────────────────────────────────────
// Numeric tolerances
// ─────────────────────────────────────────────────────────────────────

export type Tolerances = {
  /** Lower bound of the contract-price-vs-market-value band (e.g. 0.6 = -40%). */
  salePriceVarianceLow: number
  /** Upper bound of the contract-price-vs-market-value band (e.g. 1.4 = +40%). */
  salePriceVarianceHigh: number
  /** Wire-amount-vs-purchase-price ratio that triggers wire.amount_unusual. */
  wireAmountRedFlagRatio: number
}

/**
 * Catalog defaults — these are the historical hardcoded values from
 * reconciliation.ts. Changing one here changes the default for every
 * tenant who hasn't set an override. Treat as a calibration knob.
 */
export const DEFAULT_TOLERANCES: Tolerances = {
  salePriceVarianceLow: 0.6,
  salePriceVarianceHigh: 1.4,
  wireAmountRedFlagRatio: 1.5,
}

export const TOLERANCE_BOUNDS: Record<
  keyof Tolerances,
  { min: number; max: number; step: number }
> = {
  salePriceVarianceLow: { min: 0.1, max: 1, step: 0.05 },
  salePriceVarianceHigh: { min: 1, max: 3, step: 0.05 },
  wireAmountRedFlagRatio: { min: 1.05, max: 5, step: 0.05 },
}

// ─────────────────────────────────────────────────────────────────────
// Required-document catalog (used by the per-transaction-type override UI)
// ─────────────────────────────────────────────────────────────────────

export type DocCatalogEntry = {
  /** Stable identifier matched against `documents.docType`. */
  type: string
  /** Short human-readable label for the admin UI. */
  label: string
  /** What the doc covers — helps owners decide whether to require it. */
  description: string
}

/**
 * Catalog of doc types an owner can choose to require per transaction type.
 * The reconciler emits `missing_required_documents` when the file's doc set
 * doesn't cover the required list — these are the choices that show up in
 * the admin UI.
 *
 * Ordering matters: list goes top-to-bottom in the UI, so put the most
 * commonly-required docs first.
 */
export const REQUIRED_DOC_CATALOG: ReadonlyArray<DocCatalogEntry> = [
  {
    type: 'purchase_agreement',
    label: 'Purchase agreement',
    description: 'Executed contract between buyer and seller.',
  },
  {
    type: 'title_search',
    label: 'Title search',
    description: 'Examiner search results for the property.',
  },
  {
    type: 'commitment',
    label: 'Title commitment',
    description: 'Underwriter commitment with Schedule B exceptions.',
  },
  {
    type: 'closing_disclosure',
    label: 'Closing disclosure',
    description: 'Final CD or HUD-1 settlement statement.',
  },
  {
    type: 'loan_estimate',
    label: 'Loan estimate',
    description: 'Lender estimate (TRID).',
  },
  {
    type: 'mortgage',
    label: 'Mortgage',
    description: 'Recorded security instrument.',
  },
  {
    type: 'deed_of_trust',
    label: 'Deed of trust',
    description: 'Recorded security instrument (trust-deed states).',
  },
  {
    type: 'vesting_deed',
    label: 'Vesting deed',
    description: 'Prior recorded deed establishing seller’s vesting.',
  },
  {
    type: 'payoff',
    label: 'Payoff letter',
    description: 'Lender payoff statement (refis and payoff-required deals).',
  },
  {
    type: 'wire_instructions',
    label: 'Wire instructions',
    description: 'Verified wire instructions for disbursement.',
  },
  {
    type: 'survey',
    label: 'Survey',
    description: 'Property survey or improvement location report.',
  },
  {
    type: 'tax_certificate',
    label: 'Tax certificate',
    description: 'Tax authority certificate of paid status.',
  },
  {
    type: 'hoa_certificate',
    label: 'HOA certificate',
    description: 'Estoppel / paid-current letter from the HOA.',
  },
  {
    type: 'entity_resolution',
    label: 'Entity resolution',
    description: 'Authorizing resolution for an entity party.',
  },
  {
    type: 'appraisal',
    label: 'Appraisal',
    description: 'Appraiser report (commonly lender-required).',
  },
  {
    type: 'inspection',
    label: 'Inspection',
    description: 'Buyer inspection report.',
  },
] as const

const docCatalogByType = new Map<string, DocCatalogEntry>(
  REQUIRED_DOC_CATALOG.map((entry) => [entry.type, entry])
)

export function getDocCatalogEntry(
  type: string
): DocCatalogEntry | undefined {
  return docCatalogByType.get(type)
}

/**
 * Resolve the required-doc list for every transaction type, applying any
 * per-tenant override on top of the platform `transactionTypes` baseline.
 * Returned map is keyed by transaction-type `code`. Codes that exist in
 * `transactionTypes` but have no override fall through to platform list.
 */
export async function loadRequiredDocsByCode(
  ctx: QueryCtx,
  tenantId: Id<'tenants'>
): Promise<ReadonlyMap<string, ReadonlyArray<string>>> {
  const platform = await ctx.db.query('transactionTypes').take(50)
  const overrides = await ctx.db
    .query('tenantTransactionTypeOverrides')
    .withIndex('by_tenant', (q) => q.eq('tenantId', tenantId))
    .collect()
  const overrideByCode = new Map(overrides.map((row) => [row.code, row]))
  const out = new Map<string, ReadonlyArray<string>>()
  for (const tt of platform) {
    const ov = overrideByCode.get(tt.code)
    out.set(tt.code, ov ? ov.requiredDocs : tt.requiredDocs)
  }
  return out
}

/**
 * Load tolerances for a tenant, merged against catalog defaults. Always
 * returns a fully-populated object, so reconciliation code never has to
 * branch on "did the tenant set this".
 */
export async function loadTolerances(
  ctx: QueryCtx,
  tenantId: Id<'tenants'>
): Promise<Tolerances> {
  const row = await ctx.db
    .query('tenantReconciliationTolerances')
    .withIndex('by_tenant', (q) => q.eq('tenantId', tenantId))
    .unique()
  if (!row) return DEFAULT_TOLERANCES
  return {
    salePriceVarianceLow:
      row.salePriceVarianceLow ?? DEFAULT_TOLERANCES.salePriceVarianceLow,
    salePriceVarianceHigh:
      row.salePriceVarianceHigh ?? DEFAULT_TOLERANCES.salePriceVarianceHigh,
    wireAmountRedFlagRatio:
      row.wireAmountRedFlagRatio ?? DEFAULT_TOLERANCES.wireAmountRedFlagRatio,
  }
}
