import { ConvexError, v, type Infer } from 'convex/values'
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { internal } from './_generated/api'
import {
  propertyProfileV,
  recordedDocumentV,
  taxDataV,
} from './schema'
import { recordAudit } from './lib/audit'
import { requireRole, requireTenant } from './lib/tenant'
import type { Doc, Id } from './_generated/dataModel'

// County Connect — public-records data gateway.
//
// Two surfaces:
//
//   1. Standalone /county-connect search page → `searchProperty`,
//      `getRecordedDocuments`, `getTaxData` (one-off lookups by address).
//   2. File-detail "run all checks" path → `runForFile` (orchestrator),
//      `getSnapshotForFile` (UI panel). Caches the result in
//      `propertySnapshots` so reconciliation comparators can read it from
//      a mutation context.
//
// Provider abstraction: ATTOM Data is the only live provider in v1, with a
// `mock` fallback when `ATTOM_API_KEY` isn't set. DataTree / TitleFlex slot
// in behind the same fetch helpers — see `fetchProvider*` below.

// ── Shapes (TS types derived from the schema validators) ─────────────────

export type PropertyProfile = Infer<typeof propertyProfileV>
export type RecordedDocument = Infer<typeof recordedDocumentV>
export type TaxData = Infer<typeof taxDataV>

type ProviderName = 'attom' | 'mock'

export type ProviderResult<T> =
  | { kind: 'ok'; provider: ProviderName; data: T; raw?: unknown }
  | { kind: 'error'; provider: ProviderName; message: string; raw?: unknown }

const addressArg = v.object({
  line1: v.string(),
  city: v.optional(v.string()),
  state: v.optional(v.string()),
  zip: v.optional(v.string()),
})

type AddressInput = Infer<typeof addressArg>

// ── Auth ─────────────────────────────────────────────────────────────────
// External lookups cost money per call, so `readonly` is excluded.
const lookupRoles = ['owner', 'admin', 'processor', 'closer', 'reviewer'] as const

export const _authorizeLookup = internalQuery({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...lookupRoles)
    return null
  },
})

// ── Provider: ATTOM ──────────────────────────────────────────────────────
// Docs: https://api.developer.attomdata.com/docs

const ATTOM_BASE = 'https://api.gateway.attomdata.com/propertyapi/v1.0.0'

function attomKey(): string | null {
  const k = process.env.ATTOM_API_KEY
  return k && k.length > 0 ? k : null
}

function formatAttomAddress(input: AddressInput) {
  const tail = [input.city, [input.state, input.zip].filter(Boolean).join(' ')]
    .filter((s) => s && s.length > 0)
    .join(', ')
  return { address1: input.line1, address2: tail }
}

async function attomFetch(
  path: string,
  params: Record<string, string>
): Promise<unknown> {
  const key = attomKey()
  if (!key) throw new Error('ATTOM_API_KEY_MISSING')
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${ATTOM_BASE}${path}?${qs}`, {
    headers: { apikey: key, Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`ATTOM_HTTP_${res.status}`)
  }
  return await res.json()
}

// Loose accessor for ATTOM's deeply-nested JSON.
function pick(obj: unknown, ...path: ReadonlyArray<string>): unknown {
  let cur: unknown = obj
  for (const k of path) {
    if (cur && typeof cur === 'object' && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k]
    } else {
      return null
    }
  }
  return cur ?? null
}

// ATTOM mixes camelCase and lowercase keys across endpoints (and even within
// the same response). Try several candidate paths and return the first
// non-null hit. Each `paths` entry is a "/"-separated path string.
function pickAny(obj: unknown, paths: ReadonlyArray<string>): unknown {
  for (const p of paths) {
    const v = pick(obj, ...p.split('/'))
    if (v !== null && v !== undefined && v !== '') return v
  }
  return null
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// ── Mock fallback ────────────────────────────────────────────────────────

const MOCK_PROFILE: PropertyProfile = {
  attomId: 'mock-145320331',
  apn: '49-13-19-104-019.000-027',
  address: {
    line1: '100 N Capitol Ave',
    city: 'Indianapolis',
    state: 'IN',
    zip: '46204',
  },
  owner: {
    name: 'Marion County Public Holdings LLC',
    mailingAddress: 'Same as property',
  },
  characteristics: {
    yearBuilt: 1962,
    livingAreaSqft: 4200,
    lotSizeSqft: 8500,
    propertyType: 'Commercial — Office',
  },
  lastSale: {
    date: '2019-04-15',
    price: 2_350_000,
    documentType: 'Warranty Deed',
  },
}

const MOCK_DOCUMENTS: ReadonlyArray<RecordedDocument> = [
  {
    documentType: 'Warranty Deed',
    recordingDate: '2019-04-15',
    documentNumber: 'A201900012345',
    bookPage: null,
    grantor: 'Indy Capitol Holdings LLC',
    grantee: 'Marion County Public Holdings LLC',
    amount: 2_350_000,
  },
  {
    documentType: 'Mortgage',
    recordingDate: '2019-04-15',
    documentNumber: 'A201900012346',
    bookPage: null,
    grantor: 'Marion County Public Holdings LLC',
    grantee: 'Old National Bank',
    amount: 1_750_000,
  },
  {
    documentType: 'Release of Mortgage',
    recordingDate: '2014-08-22',
    documentNumber: 'A201400034521',
    bookPage: null,
    grantor: 'Fifth Third Bank',
    grantee: 'Indy Capitol Holdings LLC',
    amount: null,
  },
]

const MOCK_TAX: TaxData = {
  taxYear: 2025,
  taxAmount: 54_320,
  assessedValue: 2_180_000,
  marketValue: 2_410_000,
  taxRateAreaCode: 'IN-MARION-CENTER',
  exemptions: [],
}

// ── Provider helpers ─────────────────────────────────────────────────────
// Each helper returns a ProviderResult so the orchestrator can record a
// per-surface status without a single failure poisoning the whole snapshot.

// Parses the /property/expandedprofile shape into our normalized profile +
// any recorded documents derivable from the response (the most recent sale
// and any concurrent mortgages with non-zero amounts). Field paths verified
// against a real ATTOM response — see CLAUDE.md for the canonical sample.
function parseExpandedProfile(
  json: unknown,
  address: AddressInput
): { profile: PropertyProfile; documents: ReadonlyArray<RecordedDocument> } | null {
  const first = pick(json, 'property', '0')
  if (!first) return null

  const sale = pick(first, 'sale')
  const profile: PropertyProfile = {
    attomId: asString(pickAny(first, ['identifier/attomId', 'identifier/Id'])),
    apn: asString(pick(first, 'identifier', 'apn')),
    address: {
      line1:
        asString(pickAny(first, ['address/line1', 'address/oneLine'])) ??
        address.line1,
      city:
        asString(pick(first, 'address', 'locality')) ?? address.city ?? '',
      state:
        asString(pick(first, 'address', 'countrySubd')) ?? address.state ?? '',
      zip: asString(pick(first, 'address', 'postal1')) ?? address.zip ?? '',
    },
    owner: {
      name: asString(pick(first, 'assessment', 'owner', 'owner1', 'fullName')),
      mailingAddress: asString(
        pick(first, 'assessment', 'owner', 'mailingAddressOneLine')
      ),
    },
    characteristics: {
      yearBuilt: asNumber(pick(first, 'summary', 'yearBuilt')),
      livingAreaSqft: asNumber(
        pickAny(first, [
          'building/size/livingSize',
          'building/size/universalSize',
          'building/size/grossSize',
        ])
      ),
      // ATTOM doesn't always populate lot size in sqft for condos / urban
      // properties — leave null when missing rather than fabricate.
      lotSizeSqft: asNumber(
        pickAny(first, ['lot/lotSize2', 'lot/lotSize1'])
      ),
      propertyType: asString(
        pickAny(first, [
          'summary/propType',
          'summary/propertyType',
          'summary/propClass',
        ])
      ),
    },
    lastSale: sale
      ? {
          date: asString(
            pickAny(sale, [
              'amount/saleRecDate',
              'saleSearchDate',
              'saleTransDate',
            ])
          ),
          price: asNumber(
            pickAny(sale, ['amount/saleAmt', 'saleAmt', 'amount/saleAmount'])
          ),
          documentType: asString(
            pickAny(sale, [
              'amount/saleTransType',
              'saleTransType',
              'amount/saleDocType',
            ])
          ),
        }
      : null,
  }

  // Synthesize recorded-document entries from the data we already have. The
  // most recent sale is always present on expandedprofile when ATTOM has any
  // record; concurrent mortgages are populated for purchase-money loans.
  const documents: RecordedDocument[] = []
  if (sale) {
    const recordingDate = asString(
      pickAny(sale, ['amount/saleRecDate', 'saleSearchDate', 'saleTransDate'])
    )
    const documentNumber = asString(
      pickAny(sale, ['amount/saleDocNum', 'transactionIdent'])
    )
    const grantor = asString(pick(sale, 'sellerName'))
    const amount = asNumber(pickAny(sale, ['amount/saleAmt', 'saleAmt']))
    // Skip synthesizing a row when ATTOM returned an empty `sale: {}` —
    // showing a row of em-dashes is worse than showing nothing. Saleshistory
    // (called separately) covers older transactions for properties without a
    // recent sale on expandedprofile.
    if (recordingDate || documentNumber || grantor || amount) {
      documents.push({
        documentType:
          asString(
            pickAny(sale, ['amount/saleTransType', 'amount/saleDocType'])
          ) ?? 'Recorded Sale',
        recordingDate,
        documentNumber,
        bookPage: null,
        grantor,
        grantee: profile.owner.name,
        amount,
      })
    }
  }

  for (const slot of ['FirstConcurrent', 'SecondConcurrent'] as const) {
    const m = pick(first, 'assessment', 'mortgage', slot)
    const amt = asNumber(pick(m, 'amount'))
    if (m && amt && amt > 0) {
      documents.push({
        documentType:
          asString(pick(m, 'deedType')) === 'LW'
            ? 'Mortgage'
            : (asString(pick(m, 'deedType')) ?? 'Mortgage'),
        recordingDate: profile.lastSale?.date ?? null,
        documentNumber: null,
        bookPage: null,
        grantor: profile.owner.name,
        grantee: asString(pick(m, 'lenderName')),
        amount: amt,
      })
    }
  }

  return { profile, documents }
}

async function fetchProviderProperty(
  address: AddressInput
): Promise<ProviderResult<PropertyProfile>> {
  if (!attomKey()) {
    return { kind: 'ok', provider: 'mock', data: MOCK_PROFILE }
  }
  try {
    const { address1, address2 } = formatAttomAddress(address)
    const json = await attomFetch('/property/expandedprofile', {
      address1,
      address2,
    })
    const parsed = parseExpandedProfile(json, address)
    if (!parsed) {
      return {
        kind: 'error',
        provider: 'attom',
        message: 'No matching property',
        raw: json,
      }
    }
    return { kind: 'ok', provider: 'attom', data: parsed.profile, raw: json }
  } catch (err) {
    return {
      kind: 'error',
      provider: 'attom',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

// Combined fetch — returns profile + the recorded-document entries we can
// derive from the same response. Used by `runForFile` to avoid a second
// API call when seeding the documents list.
async function fetchProviderPropertyAndDocs(
  address: AddressInput
): Promise<
  ProviderResult<{
    profile: PropertyProfile
    documents: ReadonlyArray<RecordedDocument>
  }>
> {
  if (!attomKey()) {
    return {
      kind: 'ok',
      provider: 'mock',
      data: { profile: MOCK_PROFILE, documents: MOCK_DOCUMENTS },
    }
  }
  try {
    const { address1, address2 } = formatAttomAddress(address)
    const json = await attomFetch('/property/expandedprofile', {
      address1,
      address2,
    })
    const parsed = parseExpandedProfile(json, address)
    if (!parsed) {
      return {
        kind: 'error',
        provider: 'attom',
        message: 'No matching property',
        raw: json,
      }
    }
    return { kind: 'ok', provider: 'attom', data: parsed, raw: json }
  } catch (err) {
    return {
      kind: 'error',
      provider: 'attom',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

async function fetchProviderDocuments(
  address: AddressInput
): Promise<ProviderResult<ReadonlyArray<RecordedDocument>>> {
  if (!attomKey()) {
    return { kind: 'ok', provider: 'mock', data: MOCK_DOCUMENTS }
  }
  try {
    const { address1, address2 } = formatAttomAddress(address)
    // expandedhistory carries grantor/grantee + transaction identifiers;
    // /saleshistory/detail returns transaction amounts but NOT party names.
    const json = await attomFetch('/saleshistory/expandedhistory', {
      address1,
      address2,
    })
    const sales = pickAny(json, [
      'property/0/saleHistory',
      'property/0/salehistory',
    ])
    const arr = Array.isArray(sales) ? sales : []
    // Field paths verified against ATTOM expandedhistory response.
    // Buyer/seller arrive as top-level strings (`buyerName` / `sellerName`),
    // not nested objects. Document number lives at `amount.saleDocNum` —
    // `transactionIdent` is ATTOM's internal ID, not the recorded doc #.
    const data: ReadonlyArray<RecordedDocument> = arr.map((s: unknown) => ({
      documentType:
        asString(
          pickAny(s, ['amount/saleTransType', 'amount/deedType'])
        ) ?? 'Recorded Document',
      recordingDate: asString(
        pickAny(s, ['amount/saleRecDate', 'saleSearchDate', 'saleTransDate'])
      ),
      documentNumber: asString(
        pickAny(s, ['amount/saleDocNum', 'transactionIdent'])
      ),
      bookPage: null,
      grantor: asString(pick(s, 'sellerName')),
      grantee: asString(pick(s, 'buyerName')),
      amount: asNumber(pickAny(s, ['amount/saleAmt'])),
    }))
    return { kind: 'ok', provider: 'attom', data, raw: json }
  } catch (err) {
    return {
      kind: 'error',
      provider: 'attom',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

async function fetchProviderTax(
  address: AddressInput
): Promise<ProviderResult<TaxData>> {
  if (!attomKey()) {
    return { kind: 'ok', provider: 'mock', data: MOCK_TAX }
  }
  try {
    const { address1, address2 } = formatAttomAddress(address)
    const json = await attomFetch('/assessment/detail', { address1, address2 })
    const first = pick(json, 'property', '0')
    if (!first) {
      return {
        kind: 'error',
        provider: 'attom',
        message: 'No tax record found',
        raw: json,
      }
    }
    const exemptionsRaw = pickAny(first, [
      'assessment/tax/exemption',
      'assessment/tax/exemptions',
    ])
    const exemptions = Array.isArray(exemptionsRaw)
      ? exemptionsRaw
          .map((e: unknown) =>
            asString(pickAny(e, ['description', 'name', 'code']))
          )
          .filter((s): s is string => s !== null)
      : []
    const data: TaxData = {
      taxYear: asNumber(
        pickAny(first, ['assessment/tax/taxyear', 'assessment/tax/taxYear'])
      ),
      taxAmount: asNumber(
        pickAny(first, ['assessment/tax/taxamt', 'assessment/tax/taxAmt'])
      ),
      assessedValue: asNumber(
        pickAny(first, [
          'assessment/assessed/assdttlvalue',
          'assessment/assessed/assdTtlValue',
        ])
      ),
      marketValue: asNumber(
        pickAny(first, [
          'assessment/market/mktttlvalue',
          'assessment/market/mktTtlValue',
        ])
      ),
      taxRateAreaCode: asString(
        pickAny(first, [
          'assessment/tax/taxratearea',
          'assessment/tax/taxRateArea',
        ])
      ),
      exemptions,
    }
    return { kind: 'ok', provider: 'attom', data, raw: json }
  } catch (err) {
    return {
      kind: 'error',
      provider: 'attom',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

// ── Standalone /county-connect actions ───────────────────────────────────

export const searchProperty = action({
  args: { address: addressArg },
  handler: async (ctx, { address }): Promise<ProviderResult<PropertyProfile>> => {
    await ctx.runQuery(internal.countyConnect._authorizeLookup, {})
    return await fetchProviderProperty(address)
  },
})

export const getRecordedDocuments = action({
  args: { address: addressArg },
  handler: async (
    ctx,
    { address }
  ): Promise<ProviderResult<ReadonlyArray<RecordedDocument>>> => {
    await ctx.runQuery(internal.countyConnect._authorizeLookup, {})
    return await fetchProviderDocuments(address)
  },
})

export const getTaxData = action({
  args: { address: addressArg },
  handler: async (ctx, { address }): Promise<ProviderResult<TaxData>> => {
    await ctx.runQuery(internal.countyConnect._authorizeLookup, {})
    return await fetchProviderTax(address)
  },
})

// ── Address autocomplete (Radar) ─────────────────────────────────────────
// Server-side proxy to https://api.radar.io/v1/search/autocomplete so the
// secret key never leaves Convex. Falls back to a small canned list when
// `RADAR_SECRET_KEY` is unset, so the UI is exercisable in dev without a
// Radar account. Set with: `npx convex env set RADAR_SECRET_KEY <key>`.

export type AddressSuggestion = {
  formatted: string
  line1: string
  city: string
  state: string
  postalCode: string
  county: string | null
  confidence: string
  latitude: number | null
  longitude: number | null
}

const RADAR_AUTOCOMPLETE_URL = 'https://api.radar.io/v1/search/autocomplete'

const MOCK_SUGGESTIONS: ReadonlyArray<AddressSuggestion> = [
  {
    formatted: '100 N Capitol Ave, Indianapolis, IN 46204',
    line1: '100 N Capitol Ave',
    city: 'Indianapolis',
    state: 'IN',
    postalCode: '46204',
    county: 'Marion County',
    confidence: 'exact',
    latitude: 39.7726,
    longitude: -86.1583,
  },
  {
    formatted: '5215 E Washington St, Indianapolis, IN 46219',
    line1: '5215 E Washington St',
    city: 'Indianapolis',
    state: 'IN',
    postalCode: '46219',
    county: 'Marion County',
    confidence: 'exact',
    latitude: 39.7701,
    longitude: -86.0807,
  },
  {
    formatted: '3324 Corey Dr, Indianapolis, IN 46227',
    line1: '3324 Corey Dr',
    city: 'Indianapolis',
    state: 'IN',
    postalCode: '46227',
    county: 'Marion County',
    confidence: 'exact',
    latitude: 39.6512,
    longitude: -86.1086,
  },
]

export const addressAutocomplete = action({
  args: { query: v.string() },
  handler: async (
    ctx,
    { query }
  ): Promise<ReadonlyArray<AddressSuggestion>> => {
    await ctx.runQuery(internal.countyConnect._authorizeLookup, {})
    const trimmed = query.trim()
    if (trimmed.length < 3) return []

    const key = process.env.RADAR_SECRET_KEY
    if (!key) {
      const lower = trimmed.toLowerCase()
      return MOCK_SUGGESTIONS.filter((s) =>
        s.formatted.toLowerCase().includes(lower)
      )
    }

    try {
      const url = new URL(RADAR_AUTOCOMPLETE_URL)
      url.searchParams.set('query', trimmed)
      url.searchParams.set('country', 'US')
      url.searchParams.set('layers', 'address')
      url.searchParams.set('limit', '6')
      const res = await fetch(url.toString(), {
        headers: { Authorization: key },
      })
      if (!res.ok) return []
      const json = (await res.json()) as { addresses?: ReadonlyArray<unknown> }
      const arr = json.addresses ?? []
      return arr
        .map((a): AddressSuggestion => ({
          formatted: asString(pick(a, 'formattedAddress')) ?? '',
          line1: asString(pick(a, 'addressLabel')) ?? '',
          city: asString(pick(a, 'city')) ?? '',
          state: asString(pick(a, 'stateCode')) ?? '',
          postalCode: asString(pick(a, 'postalCode')) ?? '',
          county: asString(pick(a, 'county')),
          confidence: asString(pick(a, 'confidence')) ?? 'unknown',
          latitude: asNumber(pick(a, 'latitude')),
          longitude: asNumber(pick(a, 'longitude')),
        }))
        .filter((s) => s.formatted.length > 0)
    } catch {
      // Network / parse failures don't surface to the user — they just see
      // no suggestions and can keep typing.
      return []
    }
  },
})

// ── File-bound orchestrator ──────────────────────────────────────────────

type FileLookupContext = {
  fileId: Id<'files'>
  address: AddressInput
  // Only populated by the user-context loader; the auto loader leaves it
  // undefined so callers must read tc.memberId directly when they need it.
  memberId?: Id<'tenantMembers'>
}

export const _loadFileForLookup = internalQuery({
  args: { fileId: v.id('files') },
  handler: async (ctx, { fileId }): Promise<FileLookupContext> => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...lookupRoles)
    const file = await ctx.db.get(fileId)
    if (!file || file.tenantId !== tc.tenantId) {
      throw new ConvexError('FILE_NOT_FOUND')
    }
    if (!file.propertyAddress) {
      throw new ConvexError('FILE_HAS_NO_ADDRESS')
    }
    return {
      fileId,
      address: {
        line1: file.propertyAddress.line1,
        city: file.propertyAddress.city,
        state: file.propertyAddress.state,
        zip: file.propertyAddress.zip,
      },
      memberId: tc.memberId,
    }
  },
})

const snapshotStatus = v.union(
  v.literal('ok'),
  v.literal('partial'),
  v.literal('error')
)

// Raw provider responses, kept per-endpoint for debugging only. Used by
// _storeSnapshot, _storeSnapshotAuto, and recordSearch — write-only from
// the public API surface.
const rawResponseArg = v.optional(
  v.object({
    property: v.optional(v.any()),
    documents: v.optional(v.any()),
    tax: v.optional(v.any()),
  })
)

export const _storeSnapshot = internalMutation({
  args: {
    fileId: v.id('files'),
    provider: v.union(v.literal('attom'), v.literal('mock')),
    queryAddress: v.object({
      line1: v.string(),
      city: v.string(),
      state: v.string(),
      zip: v.string(),
    }),
    property: v.union(propertyProfileV, v.null()),
    documents: v.array(recordedDocumentV),
    tax: v.union(taxDataV, v.null()),
    status: snapshotStatus,
    errorMessage: v.optional(v.string()),
    rawResponse: rawResponseArg,
  },
  handler: async (
    ctx,
    {
      fileId,
      provider,
      queryAddress,
      property,
      documents,
      tax,
      status,
      errorMessage,
      rawResponse,
    }
  ): Promise<Id<'propertySnapshots'>> => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...lookupRoles)
    const file = await ctx.db.get(fileId)
    if (!file || file.tenantId !== tc.tenantId) {
      throw new ConvexError('FILE_NOT_FOUND')
    }
    const id = await ctx.db.insert('propertySnapshots', {
      tenantId: tc.tenantId,
      fileId,
      provider,
      fetchedAt: Date.now(),
      fetchedByMemberId: tc.memberId,
      queryAddress,
      property,
      documents: documents.map((d) => ({ ...d })),
      tax,
      status,
      errorMessage,
      rawResponse,
    })
    await recordAudit(ctx, tc, 'county_connect.snapshot.stored', 'files', fileId, {
      provider,
      status,
      documentCount: documents.length,
    })

    await ctx.scheduler.runAfter(0, internal.pipeline.onFileChange, {
      tenantId: tc.tenantId,
      fileId,
      reason: 'snapshot_stored',
    })

    return id
  },
})

// System-context twin of `_loadFileForLookup`. Takes tenantId directly so it
// can be called from the pipeline fan-out (no user identity). Returns null
// when the file lacks an address — the auto path treats that as "nothing to
// fetch yet" instead of an error.
export const _loadFileForLookupAuto = internalQuery({
  args: { tenantId: v.id('tenants'), fileId: v.id('files') },
  handler: async (
    ctx,
    { tenantId, fileId }
  ): Promise<FileLookupContext | null> => {
    const file = await ctx.db.get(fileId)
    if (!file || file.tenantId !== tenantId) return null
    if (!file.propertyAddress) return null
    return {
      fileId,
      address: {
        line1: file.propertyAddress.line1,
        city: file.propertyAddress.city,
        state: file.propertyAddress.state,
        zip: file.propertyAddress.zip,
      },
    }
  },
})

// System-context twin of `_storeSnapshot`. Same write shape, but no member id
// on the snapshot row, a system audit event, and the pipeline fan-out keyed
// on the supplied tenantId.
export const _storeSnapshotAuto = internalMutation({
  args: {
    tenantId: v.id('tenants'),
    fileId: v.id('files'),
    provider: v.union(v.literal('attom'), v.literal('mock')),
    queryAddress: v.object({
      line1: v.string(),
      city: v.string(),
      state: v.string(),
      zip: v.string(),
    }),
    property: v.union(propertyProfileV, v.null()),
    documents: v.array(recordedDocumentV),
    tax: v.union(taxDataV, v.null()),
    status: snapshotStatus,
    errorMessage: v.optional(v.string()),
    rawResponse: rawResponseArg,
  },
  handler: async (
    ctx,
    {
      tenantId,
      fileId,
      provider,
      queryAddress,
      property,
      documents,
      tax,
      status,
      errorMessage,
      rawResponse,
    }
  ): Promise<Id<'propertySnapshots'>> => {
    const file = await ctx.db.get(fileId)
    if (!file || file.tenantId !== tenantId) {
      throw new ConvexError('FILE_NOT_FOUND')
    }
    const id = await ctx.db.insert('propertySnapshots', {
      tenantId,
      fileId,
      provider,
      fetchedAt: Date.now(),
      queryAddress,
      property,
      documents: documents.map((d) => ({ ...d })),
      tax,
      status,
      errorMessage,
      rawResponse,
    })
    await ctx.db.insert('auditEvents', {
      tenantId,
      actorType: 'system',
      action: 'county_connect.snapshot.stored',
      resourceType: 'files',
      resourceId: fileId,
      metadata: {
        provider,
        status,
        documentCount: documents.length,
        auto: true,
      },
      occurredAt: Date.now(),
    })

    await ctx.scheduler.runAfter(0, internal.pipeline.onFileChange, {
      tenantId,
      fileId,
      reason: 'snapshot_stored',
    })

    return id
  },
})

export type RunForFileResult = {
  snapshotId: Id<'propertySnapshots'>
  provider: ProviderName
  status: 'ok' | 'partial' | 'error'
  errors: ReadonlyArray<{ surface: 'property' | 'documents' | 'tax'; message: string }>
}

type AssembledSnapshot = {
  provider: ProviderName
  queryAddress: { line1: string; city: string; state: string; zip: string }
  property: PropertyProfile | null
  documents: Array<RecordedDocument>
  tax: TaxData | null
  status: 'ok' | 'partial' | 'error'
  errorMessage: string | undefined
  errors: Array<{ surface: 'property' | 'documents' | 'tax'; message: string }>
  rawResponse: {
    property?: unknown
    documents?: unknown
    tax?: unknown
  }
}

// Run the three ATTOM calls and merge them into the shape `_storeSnapshot`
// expects. Pure orchestration so the user-context action and the auto
// internalAction stay identical from a data-correctness standpoint.
async function assembleSnapshot(
  loaded: FileLookupContext
): Promise<AssembledSnapshot> {
  // Three ATTOM calls in parallel:
  //  - expandedprofile: property profile + synthesized recent-sale doc
  //  - saleshistory/expandedhistory: full chain of recorded transactions
  //  - assessment/detail: tax
  // Saleshistory failures are tolerated — we still ship the synthesized
  // doc from expandedprofile.
  const [profileR, historyR, taxR] = await Promise.all([
    fetchProviderPropertyAndDocs(loaded.address),
    fetchProviderDocuments(loaded.address),
    fetchProviderTax(loaded.address),
  ])

  const errors: Array<{
    surface: 'property' | 'documents' | 'tax'
    message: string
  }> = []
  if (profileR.kind === 'error') {
    errors.push({ surface: 'property', message: profileR.message })
  }
  if (historyR.kind === 'error') {
    errors.push({ surface: 'documents', message: historyR.message })
  }
  if (taxR.kind === 'error') {
    errors.push({ surface: 'tax', message: taxR.message })
  }

  const okCount = [profileR, historyR, taxR].filter(
    (r) => r.kind === 'ok'
  ).length
  const status: 'ok' | 'partial' | 'error' =
    okCount === 3 ? 'ok' : okCount === 0 ? 'error' : 'partial'

  const successfulProvider =
    profileR.kind === 'ok'
      ? profileR.provider
      : historyR.kind === 'ok'
        ? historyR.provider
        : taxR.kind === 'ok'
          ? taxR.provider
          : 'attom'

  // Merge documents from both sources — synthesized recent-sale entries
  // first, then historical entries that aren't already represented by
  // recording date + document number.
  const synthesized =
    profileR.kind === 'ok' ? [...profileR.data.documents] : []
  const history = historyR.kind === 'ok' ? [...historyR.data] : []
  const seen = new Set(
    synthesized.map((d) => `${d.recordingDate ?? ''}::${d.documentNumber ?? ''}`)
  )
  const merged = [
    ...synthesized,
    ...history.filter(
      (d) =>
        !seen.has(`${d.recordingDate ?? ''}::${d.documentNumber ?? ''}`)
    ),
  ]

  return {
    provider: successfulProvider,
    queryAddress: {
      line1: loaded.address.line1,
      city: loaded.address.city ?? '',
      state: loaded.address.state ?? '',
      zip: loaded.address.zip ?? '',
    },
    property: profileR.kind === 'ok' ? profileR.data.profile : null,
    documents: merged,
    tax: taxR.kind === 'ok' ? taxR.data : null,
    status,
    errorMessage:
      errors.length > 0
        ? errors.map((e) => `${e.surface}: ${e.message}`).join('; ')
        : undefined,
    errors,
    rawResponse: {
      property: profileR.raw,
      documents: historyR.raw,
      tax: taxR.raw,
    },
  }
}

export const runForFile = action({
  args: { fileId: v.id('files') },
  handler: async (ctx, { fileId }): Promise<RunForFileResult> => {
    const loaded: FileLookupContext = await ctx.runQuery(
      internal.countyConnect._loadFileForLookup,
      { fileId }
    )

    const snap = await assembleSnapshot(loaded)

    const snapshotId: Id<'propertySnapshots'> = await ctx.runMutation(
      internal.countyConnect._storeSnapshot,
      {
        fileId,
        provider: snap.provider,
        queryAddress: snap.queryAddress,
        property: snap.property,
        documents: snap.documents,
        tax: snap.tax,
        status: snap.status,
        errorMessage: snap.errorMessage,
        rawResponse: snap.rawResponse,
      }
    )

    return {
      snapshotId,
      provider: snap.provider,
      status: snap.status,
      errors: snap.errors,
    }
  },
})

// System-context twin of `runForFile`. Scheduled from `pipeline.onFileChange`
// when the file's address changes so the snapshot is always pulled against
// the current address. No-op when the file has no address yet — the user's
// next address edit will trigger us anyway.
export const runForFileAuto = internalAction({
  args: { tenantId: v.id('tenants'), fileId: v.id('files') },
  handler: async (ctx, { tenantId, fileId }): Promise<null> => {
    const loaded = await ctx.runQuery(
      internal.countyConnect._loadFileForLookupAuto,
      { tenantId, fileId }
    )
    if (!loaded) return null

    const snap = await assembleSnapshot(loaded)

    await ctx.runMutation(internal.countyConnect._storeSnapshotAuto, {
      tenantId,
      fileId,
      provider: snap.provider,
      queryAddress: snap.queryAddress,
      property: snap.property,
      documents: snap.documents,
      tax: snap.tax,
      status: snap.status,
      errorMessage: snap.errorMessage,
      rawResponse: snap.rawResponse,
    })

    return null
  },
})

// ── UI query ─────────────────────────────────────────────────────────────

export type SnapshotForFile = {
  _id: Id<'propertySnapshots'>
  fetchedAt: number
  provider: ProviderName
  status: 'ok' | 'partial' | 'error'
  errorMessage: string | null
  queryAddress: Doc<'propertySnapshots'>['queryAddress']
  property: PropertyProfile | null
  documents: ReadonlyArray<RecordedDocument>
  tax: TaxData | null
  chainSummary: {
    bullets: ReadonlyArray<string>
    missing: ReadonlyArray<string>
    generatedAt: number
  } | null
}

export const getSnapshotForFile = query({
  args: { fileId: v.id('files') },
  handler: async (ctx, { fileId }): Promise<SnapshotForFile | null> => {
    const tc = await requireTenant(ctx)
    const file = await ctx.db.get(fileId)
    if (!file || file.tenantId !== tc.tenantId) return null
    const row = await ctx.db
      .query('propertySnapshots')
      .withIndex('by_tenant_file_fetched', (q) =>
        q.eq('tenantId', tc.tenantId).eq('fileId', fileId)
      )
      .order('desc')
      .first()
    if (!row) return null
    return {
      _id: row._id,
      fetchedAt: row.fetchedAt,
      provider: row.provider,
      status: row.status,
      errorMessage: row.errorMessage ?? null,
      queryAddress: row.queryAddress,
      property: row.property,
      documents: row.documents,
      tax: row.tax,
      chainSummary: row.chainSummary ?? null,
    }
  },
})

// ─── Recent searches (per tenantMember) ──────────────────────────────────

export type RecentSearch = {
  _id: Id<'countyConnectSearches'>
  query: string
  ownerName: string | null
  fetchedAt: number
  provider: ProviderName
  property: PropertyProfile | null
  documents: ReadonlyArray<RecordedDocument>
  tax: TaxData | null
}

const RECENTS_VISIBLE = 8
const RECENTS_KEEP = 20

export const listRecentSearches = query({
  args: {},
  handler: async (ctx): Promise<ReadonlyArray<RecentSearch>> => {
    const tc = await requireTenant(ctx)
    const rows = await ctx.db
      .query('countyConnectSearches')
      .withIndex('by_tenant_member_fetched', (q) =>
        q.eq('tenantId', tc.tenantId).eq('memberId', tc.memberId)
      )
      .order('desc')
      .take(RECENTS_VISIBLE)
    return rows.map((r) => ({
      _id: r._id,
      query: r.query,
      ownerName: r.ownerName,
      fetchedAt: r.fetchedAt,
      provider: r.provider,
      property: r.property,
      documents: r.documents,
      tax: r.tax,
    }))
  },
})

export const recordSearch = mutation({
  args: {
    query: v.string(),
    ownerName: v.union(v.string(), v.null()),
    provider: v.union(v.literal('attom'), v.literal('mock')),
    property: v.union(propertyProfileV, v.null()),
    documents: v.array(recordedDocumentV),
    tax: v.union(taxDataV, v.null()),
    rawResponse: rawResponseArg,
  },
  handler: async (ctx, args): Promise<null> => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...lookupRoles)

    // Dedup: drop any existing row with same query for this member.
    const existing = await ctx.db
      .query('countyConnectSearches')
      .withIndex('by_tenant_member_query', (q) =>
        q
          .eq('tenantId', tc.tenantId)
          .eq('memberId', tc.memberId)
          .eq('query', args.query)
      )
      .take(5)
    for (const e of existing) await ctx.db.delete(e._id)

    await ctx.db.insert('countyConnectSearches', {
      tenantId: tc.tenantId,
      memberId: tc.memberId,
      query: args.query,
      ownerName: args.ownerName,
      fetchedAt: Date.now(),
      provider: args.provider,
      property: args.property,
      documents: args.documents.map((d) => ({ ...d })),
      tax: args.tax,
      rawResponse: args.rawResponse,
    })

    // Cap retention. Take one beyond the keep limit; if any return, the
    // member has more rows than allowed and we need to trim the oldest.
    const all = await ctx.db
      .query('countyConnectSearches')
      .withIndex('by_tenant_member_fetched', (q) =>
        q.eq('tenantId', tc.tenantId).eq('memberId', tc.memberId)
      )
      .order('desc')
      .take(RECENTS_KEEP + 10)
    if (all.length > RECENTS_KEEP) {
      for (const old of all.slice(RECENTS_KEEP)) {
        await ctx.db.delete(old._id)
      }
    }
    return null
  },
})

export const clearRecentSearches = mutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const tc = await requireTenant(ctx)
    const all = await ctx.db
      .query('countyConnectSearches')
      .withIndex('by_tenant_member_fetched', (q) =>
        q.eq('tenantId', tc.tenantId).eq('memberId', tc.memberId)
      )
      .take(RECENTS_KEEP + 10)
    for (const r of all) await ctx.db.delete(r._id)
    return null
  },
})

// ── AI chain-of-title summary ─────────────────────────────────────────
// Loads context for the chainSummary action and applies the result back.
// Action lives in convex/chainSummary.ts ('use node') for the Anthropic
// SDK; the helpers live here next to the table they manage.

export const _loadChainContext = internalQuery({
  args: { snapshotId: v.id('propertySnapshots') },
  handler: async (ctx, { snapshotId }) => {
    const snap = await ctx.db.get(snapshotId)
    if (!snap) return null
    const file = await ctx.db.get(snap.fileId)
    if (!file) return null
    return {
      snapshotId: snap._id,
      tenantId: snap.tenantId,
      property: snap.property,
      documents: snap.documents,
      tax: snap.tax,
      file: {
        fileNumber: file.fileNumber,
        transactionType: file.transactionType,
        propertyAddress: file.propertyAddress ?? null,
      },
    }
  },
})

export const _applyChainSummary = internalMutation({
  args: {
    snapshotId: v.id('propertySnapshots'),
    bullets: v.array(v.string()),
    missing: v.array(v.string()),
  },
  handler: async (ctx, { snapshotId, bullets, missing }) => {
    const snap = await ctx.db.get(snapshotId)
    if (!snap) return
    await ctx.db.patch(snapshotId, {
      chainSummary: {
        bullets: bullets
          .map((b) => b.trim())
          .filter((b) => b.length > 0)
          .slice(0, 6)
          .map((b) => b.slice(0, 400)),
        missing: missing
          .map((m) => m.trim())
          .filter((m) => m.length > 0)
          .slice(0, 6)
          .map((m) => m.slice(0, 400)),
        generatedAt: Date.now(),
      },
    })
  },
})

const summaryRoles = ['owner', 'admin', 'processor', 'closer', 'reviewer'] as const

// Public: editor schedules a chain-of-title summary. Audited so deployments
// can see which snapshots were AI-reviewed.
export const requestChainSummary = mutation({
  args: { snapshotId: v.id('propertySnapshots') },
  handler: async (ctx, { snapshotId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...summaryRoles)
    const snap = await ctx.db.get(snapshotId)
    if (!snap || snap.tenantId !== tc.tenantId) {
      throw new ConvexError('SNAPSHOT_NOT_FOUND')
    }
    await ctx.scheduler.runAfter(0, internal.chainSummary.summarize, {
      snapshotId,
    })
    await recordAudit(
      ctx,
      tc,
      'chain_summary.requested',
      'file',
      snap.fileId,
      { snapshotId }
    )
    return { ok: true }
  },
})
