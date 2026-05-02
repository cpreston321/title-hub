import { createFileRoute, redirect } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAction } from 'convex/react'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Command as Cmdk } from 'cmdk'
import { Building2, Loader2, Receipt, ScrollText, Search } from 'lucide-react'
import { api } from '../../convex/_generated/api'
import type {
  AddressSuggestion,
  PropertyProfile,
  ProviderResult,
  RecentSearch,
  RecordedDocument,
  TaxData,
} from '../../convex/countyConnect'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { AppShell } from '@/components/app-shell'

export const Route = createFileRoute('/county-connect')({
  head: () => ({
    meta: [
      { title: 'County connect · Title Hub' },
      {
        name: 'description',
        content:
          'Public records, recorded chain, and tax data for any U.S. parcel.',
      },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!(context as { isAuthenticated?: boolean }).isAuthenticated) {
      throw redirect({ to: '/signin' })
    }
  },
  component: CountyConnectPage,
})

// ─── Address parsing & search heuristic ────────────────────────────────────

type Address = { line1: string; city: string; state: string; zip: string }

function parseAddress(raw: string): Address {
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  const line1 = parts[0] ?? raw
  const tail = parts.slice(1).join(' ')
  const m = tail.match(/^(.*?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i)
  if (m) {
    return {
      line1,
      city: m[1]!.trim(),
      state: m[2]!.toUpperCase(),
      zip: m[3]!,
    }
  }
  return { line1, city: parts[1] ?? '', state: '', zip: '' }
}

function isSearchable(s: string): boolean {
  const t = s.trim()
  return t.length >= 6 && /\d+\s+\S{2,}/.test(t)
}

// ─── Page ──────────────────────────────────────────────────────────────────

type Bundle = {
  property: PropertyProfile | null
  docs: ReadonlyArray<RecordedDocument> | null
  tax: TaxData | null
  provider: 'attom' | 'mock' | null
  error: string | null
}

const EMPTY: Bundle = {
  property: null,
  docs: null,
  tax: null,
  provider: null,
  error: null,
}

const SUGGESTIONS = [
  '100 N Capitol Ave, Indianapolis, IN 46204',
  '5215 E Washington St, Indianapolis, IN 46219',
  '3324 Corey Dr, Indianapolis, IN 46227',
]

// Recents persist in Convex (`countyConnectSearches` table, per
// tenantMember). The full bundle is stored so a click-to-rerun renders
// without a paid ATTOM call — see api.countyConnect.recordSearch.

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function CountyConnectPage() {
  const current = useQuery(convexQuery(api.tenants.current, {}))
  const searchProperty = useAction(api.countyConnect.searchProperty)
  const getRecordedDocuments = useAction(api.countyConnect.getRecordedDocuments)
  const getTaxData = useAction(api.countyConnect.getTaxData)

  const recentsQ = useQuery(
    convexQuery(api.countyConnect.listRecentSearches, {})
  )
  const recordSearch = useConvexMutation(api.countyConnect.recordSearch)
  const clearRecentSearchesM = useConvexMutation(
    api.countyConnect.clearRecentSearches
  )
  const addressAutocomplete = useAction(api.countyConnect.addressAutocomplete)

  const [input, setInput] = useState('')
  const [bundle, setBundle] = useState<Bundle>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [suggestions, setSuggestions] = useState<
    ReadonlyArray<AddressSuggestion>
  >([])
  const [suggestionsBusy, setSuggestionsBusy] = useState(false)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const cache = useRef(new Map<string, Bundle>())
  const seq = useRef(0)
  const autoSeq = useRef(0)
  // Tracks the last query the user picked from the suggestion list so the
  // autocomplete effect doesn't re-fetch suggestions for that exact value
  // (which would re-open the popover the user just closed by selecting).
  const lastPickedRef = useRef<string>('')

  if (current.data === null) {
    throw redirect({ to: '/' })
  }

  const recents = (recentsQ.data ?? []) as ReadonlyArray<RecentSearch>

  // Pre-seed the in-memory cache from server recents whenever the list
  // changes, so clicking a recent renders the stored bundle instantly with
  // no paid ATTOM call.
  useEffect(() => {
    for (const r of recents) {
      cache.current.set(r.query, {
        property: r.property,
        docs: r.documents,
        tax: r.tax,
        provider: r.provider,
        error: null,
      })
    }
  }, [recents])

  const clearRecents = async () => {
    try {
      await clearRecentSearchesM({})
    } catch {
      // best-effort — UI will refetch on next mutation
    }
  }

  // Imperative ATTOM search. Fires only when the user picks an address
  // (suggestion, recent, or sample) — never on raw typing — so paid ATTOM
  // calls map 1:1 to deliberate user intent. Per-query cache means clicking
  // the same address twice in a session is free; recents pre-seed the cache
  // on mount.
  const fireSearch = async (rawQuery: string) => {
    const trimmed = rawQuery.trim()
    if (!trimmed) {
      setBundle(EMPTY)
      setBusy(false)
      return
    }
    const cached = cache.current.get(trimmed)
    if (cached) {
      setBundle(cached)
      setBusy(false)
      return
    }
    setBusy(true)
    const mySeq = ++seq.current
    try {
      const args = { address: parseAddress(trimmed) }
      const [p, d, t] = (await Promise.all([
        searchProperty(args),
        getRecordedDocuments(args),
        getTaxData(args),
      ])) as [
        ProviderResult<PropertyProfile>,
        ProviderResult<ReadonlyArray<RecordedDocument>>,
        ProviderResult<TaxData>,
      ]
      if (mySeq !== seq.current) return
      const firstError = [p, d, t].find((r) => r.kind === 'error')
      const next: Bundle = {
        property: p.kind === 'ok' ? p.data : null,
        docs: d.kind === 'ok' ? d.data : null,
        tax: t.kind === 'ok' ? t.data : null,
        provider: p.kind === 'ok' ? p.provider : null,
        error:
          firstError && firstError.kind === 'error'
            ? firstError.message
            : null,
      }
      cache.current.set(trimmed, next)
      setBundle(next)
      const gotResults =
        next.property !== null ||
        (next.docs !== null && next.docs.length > 0) ||
        next.tax !== null
      if (gotResults) {
        try {
          await recordSearch({
            query: trimmed,
            ownerName: next.property?.owner.name ?? null,
            provider: next.provider ?? 'attom',
            property: next.property,
            documents: next.docs ? [...next.docs] : [],
            tax: next.tax,
            rawResponse: {
              property: p.raw,
              documents: d.raw,
              tax: t.raw,
            },
          })
        } catch {
          // recording history is best-effort; the search itself succeeded
        }
      }
    } catch (err) {
      if (mySeq !== seq.current) return
      const msg = err instanceof Error ? err.message : String(err)
      setBundle({ ...EMPTY, error: msg.replace(/^.*ConvexError:\s*/, '') })
    } finally {
      if (mySeq === seq.current) setBusy(false)
    }
  }

  // Used by suggestion picks AND empty-state click-throughs (recents +
  // sample addresses). Synchronous state updates first; the search fires
  // afterward with the same trimmed value.
  const consumeQuery = (query: string) => {
    lastPickedRef.current = query
    setInput(query)
    setSuggestions([])
    setSuggestionsOpen(false)
    void fireSearch(query)
  }

  // Address autocomplete (Radar). 200ms debounce, race-safe via autoSeq —
  // independent from the 600ms ATTOM debounce, so suggestions arrive long
  // before any paid lookup fires. Skips the fetch when the input matches a
  // suggestion the user just picked, so the popover stays closed.
  useEffect(() => {
    const trimmed = input.trim()
    if (trimmed.length < 3) {
      setSuggestions([])
      setSuggestionsBusy(false)
      return
    }
    if (trimmed === lastPickedRef.current) {
      setSuggestionsBusy(false)
      return
    }
    setSuggestionsBusy(true)
    const mySeq = ++autoSeq.current
    const handle = setTimeout(async () => {
      try {
        const list = await addressAutocomplete({ query: trimmed })
        if (mySeq !== autoSeq.current) return
        setSuggestions(list)
      } catch {
        if (mySeq !== autoSeq.current) return
        setSuggestions([])
      } finally {
        if (mySeq === autoSeq.current) setSuggestionsBusy(false)
      }
    }, 200)
    return () => clearTimeout(handle)
  }, [input, addressAutocomplete])

  const pickSuggestion = (s: AddressSuggestion) => {
    consumeQuery(s.formatted)
  }

  const hasResults =
    bundle.property !== null ||
    (bundle.docs !== null && bundle.docs.length > 0) ||
    bundle.tax !== null

  const showSuggestions =
    suggestionsOpen &&
    input.trim().length >= 3 &&
    input.trim() !== lastPickedRef.current &&
    (suggestionsBusy || suggestions.length > 0)

  const subtitle = current.data
    ? `${current.data.legalName} · ${current.data.role}`
    : undefined

  const status = busy
    ? 'Pulling county records…'
    : hasResults
      ? `Showing records for ${input.trim()}.`
      : input.length === 0
        ? 'Type to find an address — pick one to search.'
        : suggestionsBusy
          ? 'Looking up addresses…'
          : 'Pick an address from the list to search.'

  return (
    <AppShell isAuthenticated title="County connect" subtitle={subtitle}>
      <div className="flex flex-col gap-6 pb-12">
        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="font-display text-4xl leading-[1] font-semibold tracking-tight text-[#40233f] md:text-5xl">
                County connect
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Owner of record, recorded chain of title, and tax data for any
                U.S. parcel — direct from public-records sources. Useful for
                vesting reconciliation, exception triage, and curative work.
              </p>
            </div>
            {bundle.provider === 'mock' && (
              <span className="rounded-full border border-[#b78625]/40 bg-[#b78625]/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-[#b78625]">
                Demo mode
              </span>
            )}
          </div>
        </header>

        <Card className="overflow-visible">
          <CardContent className="p-4 md:p-5">
            <Cmdk
              shouldFilter={false}
              loop
              className="relative"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSuggestionsOpen(false)
              }}
            >
              <div className="relative">
                <Search
                  className={`pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 ${input.length > 0 ? 'text-[#40233f]' : 'text-muted-foreground'}`}
                />
                <Cmdk.Input
                  value={input}
                  onValueChange={(v) => {
                    setInput(v)
                    setSuggestionsOpen(true)
                    // Typing past a previously-picked address re-enables
                    // autocomplete fetches.
                    if (v.trim() !== lastPickedRef.current) {
                      lastPickedRef.current = ''
                    }
                  }}
                  onFocus={() => setSuggestionsOpen(true)}
                  onBlur={() => setSuggestionsOpen(false)}
                  placeholder="100 N Capitol Ave, Indianapolis, IN 46204"
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  className="flex h-12 w-full rounded-md border border-input bg-transparent px-3 py-1 pl-9 pr-10 text-base text-foreground shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  {busy ? (
                    <Loader2 className="size-4 animate-spin text-[#b78625]" />
                  ) : suggestionsBusy ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground/60" />
                  ) : null}
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>{status}</span>
                {hasResults && (
                  <span className="font-mono">
                    src: {bundle.provider ?? '—'}
                  </span>
                )}
              </div>

              {showSuggestions && (
                <Cmdk.List className="absolute left-0 right-0 top-full z-30 mt-2 max-h-72 overflow-y-auto rounded-md border bg-popover p-1 shadow-lg">
                  <Cmdk.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
                    {suggestionsBusy
                      ? 'Looking up addresses…'
                      : 'No addresses match.'}
                  </Cmdk.Empty>
                  {suggestions.length > 0 && (
                    <Cmdk.Group
                      heading="Address suggestions"
                      className="overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-[#b78625]"
                    >
                      {suggestions.map((s) => (
                        <Cmdk.Item
                          key={`${s.formatted}-${s.latitude}-${s.longitude}`}
                          value={s.formatted}
                          onSelect={() => pickSuggestion(s)}
                          onMouseDown={(e) => e.preventDefault()}
                          className="flex cursor-pointer items-center justify-between gap-3 rounded-sm px-3 py-2.5 text-sm outline-none aria-selected:bg-muted aria-selected:text-foreground"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-foreground">
                              {s.line1 || s.formatted}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {[s.city, s.state, s.postalCode]
                                .filter(Boolean)
                                .join(', ')}
                              {s.county ? ` · ${s.county}` : ''}
                            </div>
                          </div>
                          <span
                            className={`shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                              s.confidence === 'exact'
                                ? 'bg-[#b78625]/15 text-[#b78625]'
                                : 'bg-muted text-muted-foreground'
                            }`}
                          >
                            {s.confidence}
                          </span>
                        </Cmdk.Item>
                      ))}
                    </Cmdk.Group>
                  )}
                </Cmdk.List>
              )}
            </Cmdk>
          </CardContent>
        </Card>

        {bundle.error && (
          <div className="rounded-md border border-[#b94f58]/30 bg-[#fdecee] px-3 py-2 text-sm text-[#8a3942]">
            {bundle.error}
          </div>
        )}

        {!hasResults && !bundle.error ? (
          <EmptyState
            input={input}
            recents={recents}
            onSuggest={(s) => consumeQuery(s)}
            onClearRecents={clearRecents}
          />
        ) : (
          <>
            <PropertyCard property={bundle.property} />
            <ChainCard
              docs={bundle.docs ?? []}
              currentOwner={bundle.property?.owner.name ?? null}
            />
            <TaxCard tax={bundle.tax} />
          </>
        )}
      </div>
    </AppShell>
  )
}

// ─── Property card ─────────────────────────────────────────────────────────

function PropertyCard({ property }: { property: PropertyProfile | null }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-md border border-[#40233f]/15 bg-[#fdf6e8] text-[#40233f]">
            <Building2 className="size-4" />
          </span>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[#b78625]">
              Property profile
            </div>
            <CardTitle className="font-display text-xl font-semibold tracking-tight text-[#40233f]">
              The parcel
            </CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!property ? (
          <p className="text-sm text-muted-foreground">
            ATTOM did not return a property profile for this address.
          </p>
        ) : (
          <PropertyBody property={property} />
        )}
      </CardContent>
    </Card>
  )
}

function PropertyBody({ property }: { property: PropertyProfile }) {
  const a = property.address
  const c = property.characteristics
  const sale = property.lastSale
  const fullAddress = [a.line1, a.city, [a.state, a.zip].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ')

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-12">
      <div className="md:col-span-7">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Owner of record
        </div>
        <div className="font-display mt-1 text-2xl font-semibold tracking-tight text-[#40233f] md:text-3xl">
          {property.owner.name ?? (
            <span className="italic font-normal text-muted-foreground">
              Not on file
            </span>
          )}
        </div>
        <div className="mt-2 text-sm text-foreground">{fullAddress}</div>
        {property.owner.mailingAddress && (
          <div className="mt-1 text-xs text-muted-foreground">
            Mailing: {property.owner.mailingAddress}
          </div>
        )}

        {sale && (
          <div className="mt-5 rounded-md border bg-muted/30 p-3">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Last recorded sale
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
              <span className="font-mono text-foreground">
                {sale.date ?? '—'}
              </span>
              <span className="text-muted-foreground">
                {sale.documentType ?? '—'}
              </span>
              <span className="font-medium tabular-nums text-[#40233f]">
                {sale.price !== null
                  ? `$${sale.price.toLocaleString()}`
                  : 'non-disclosure'}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-x-4 gap-y-0 md:col-span-5">
        <DataRow label="Parcel (APN)" value={property.apn} mono />
        <DataRow label="ATTOM ID" value={property.attomId} mono />
        <DataRow label="Property type" value={c.propertyType} />
        <DataRow label="Year built" value={c.yearBuilt} mono />
        <DataRow
          label="Living area"
          value={
            c.livingAreaSqft
              ? `${c.livingAreaSqft.toLocaleString()} sqft`
              : null
          }
          mono
        />
        <DataRow
          label="Lot"
          value={
            c.lotSizeSqft ? `${c.lotSizeSqft.toLocaleString()} sqft` : null
          }
          mono
          last
        />
      </div>
    </div>
  )
}

function DataRow({
  label,
  value,
  mono = false,
  last = false,
}: {
  label: string
  value: string | number | null | undefined
  mono?: boolean
  last?: boolean
}) {
  const display =
    value === null || value === undefined || value === ''
      ? '—'
      : String(value)
  const isEmpty = display === '—'
  return (
    <div
      className={`flex items-baseline justify-between gap-3 py-2 text-sm ${last ? '' : 'border-b border-border/70'}`}
    >
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={`text-right ${mono ? 'font-mono text-xs' : ''} ${isEmpty ? 'text-muted-foreground' : 'text-foreground'}`}
      >
        {display}
      </span>
    </div>
  )
}

// ─── Chain of title ────────────────────────────────────────────────────────

function ChainCard({
  docs,
  currentOwner,
}: {
  docs: ReadonlyArray<RecordedDocument>
  currentOwner: string | null
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-md border border-[#40233f]/15 bg-[#fdf6e8] text-[#40233f]">
            <ScrollText className="size-4" />
          </span>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[#b78625]">
              Recorded chain
            </div>
            <CardTitle className="font-display text-xl font-semibold tracking-tight text-[#40233f]">
              Chain of title
              {docs.length > 0 && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  ({docs.length})
                </span>
              )}
            </CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {docs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No recorded transactions returned for this parcel.
          </p>
        ) : (
          <ol className="relative ml-1 border-l border-border">
            {docs.map((d, i) => (
              <ChainEntry
                key={`${d.documentNumber ?? i}-${d.recordingDate ?? i}`}
                doc={d}
                isCurrent={
                  i === 0 &&
                  currentOwner !== null &&
                  d.grantee !== null &&
                  normalizeName(d.grantee) === normalizeName(currentOwner)
                }
              />
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}

function normalizeName(s: string): string {
  return s
    .toUpperCase()
    .replace(/[,.&]/g, ' ')
    .replace(/\bLLC\b|\bINC\b|\bCORP\b|\bCO\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function ChainEntry({
  doc,
  isCurrent,
}: {
  doc: RecordedDocument
  isCurrent: boolean
}) {
  return (
    <li className="relative pb-6 pl-6 last:pb-0">
      <span
        className={`absolute -left-[5px] top-1.5 grid size-2.5 place-items-center rounded-full border-2 ${
          isCurrent
            ? 'border-[#b78625] bg-card'
            : 'border-border bg-card'
        }`}
        aria-hidden
      >
        {isCurrent && <span className="size-1 rounded-full bg-[#b78625]" />}
      </span>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <time className="font-mono text-xs text-muted-foreground">
          {doc.recordingDate ?? '—'}
        </time>
        <span className="text-sm font-medium text-foreground">
          {doc.documentType}
        </span>
        {isCurrent && (
          <span className="rounded-full border border-[#b78625]/40 bg-[#b78625]/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#b78625]">
            Current vesting
          </span>
        )}
      </div>

      <div className="mt-1.5 text-sm leading-snug text-foreground">
        <span className="text-muted-foreground">
          {doc.grantor ?? <span className="italic">unknown grantor</span>}
        </span>
        <span className="mx-2 text-[#b78625]">→</span>
        <span className="font-medium text-[#40233f]">
          {doc.grantee ?? <span className="italic">unknown grantee</span>}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
        <span>
          Doc #{' '}
          <span className="font-mono text-foreground">
            {doc.documentNumber ?? doc.bookPage ?? '—'}
          </span>
        </span>
        <span>
          Amount{' '}
          <span className="font-mono tabular-nums text-foreground">
            {doc.amount !== null ? `$${doc.amount.toLocaleString()}` : '—'}
          </span>
        </span>
      </div>
    </li>
  )
}

// ─── Tax card ──────────────────────────────────────────────────────────────

function TaxCard({ tax }: { tax: TaxData | null }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-md border border-[#40233f]/15 bg-[#fdf6e8] text-[#40233f]">
            <Receipt className="size-4" />
          </span>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[#b78625]">
              Assessment & tax
            </div>
            <CardTitle className="font-display text-xl font-semibold tracking-tight text-[#40233f]">
              The ledger
            </CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!tax ? (
          <p className="text-sm text-muted-foreground">
            No tax record returned for this parcel.
          </p>
        ) : (
          <TaxBody tax={tax} />
        )}
      </CardContent>
    </Card>
  )
}

function TaxBody({ tax }: { tax: TaxData }) {
  const ratio =
    tax.assessedValue && tax.marketValue && tax.marketValue > 0
      ? Math.round((tax.assessedValue / tax.marketValue) * 100)
      : null

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-12">
      <div className="md:col-span-5">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Annual property tax · {tax.taxYear ?? '—'}
        </div>
        <div className="font-display mt-1 text-3xl font-semibold tracking-tight tabular-nums text-[#40233f] md:text-4xl">
          {tax.taxAmount !== null
            ? `$${tax.taxAmount.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}`
            : '—'}
        </div>
        {tax.taxRateAreaCode && (
          <div className="mt-2 text-xs text-muted-foreground">
            Rate area:{' '}
            <span className="font-mono text-foreground">
              {tax.taxRateAreaCode}
            </span>
          </div>
        )}
        {tax.exemptions.length > 0 && (
          <div className="mt-2 text-xs text-muted-foreground">
            Exemptions: {tax.exemptions.join(', ')}
          </div>
        )}
      </div>

      <div className="md:col-span-7">
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Assessed
            </div>
            <div className="font-display mt-1 text-xl font-semibold tabular-nums tracking-tight text-foreground">
              {tax.assessedValue !== null
                ? `$${tax.assessedValue.toLocaleString()}`
                : '—'}
            </div>
          </div>
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Market
            </div>
            <div className="font-display mt-1 text-xl font-semibold tabular-nums tracking-tight text-[#40233f]">
              {tax.marketValue !== null
                ? `$${tax.marketValue.toLocaleString()}`
                : '—'}
            </div>
          </div>
        </div>
        {ratio !== null && (
          <div className="mt-4">
            <div className="flex items-baseline justify-between text-xs text-muted-foreground">
              <span>Assessment ratio</span>
              <span className="font-mono tabular-nums text-foreground">
                {ratio}%
              </span>
            </div>
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-1 rounded-full bg-[#b78625]"
                style={{ width: `${Math.min(100, ratio)}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Empty state ───────────────────────────────────────────────────────────

function EmptyState({
  input,
  recents,
  onSuggest,
  onClearRecents,
}: {
  input: string
  recents: ReadonlyArray<RecentSearch>
  onSuggest: (s: string) => void
  onClearRecents: () => void
}) {
  const showHint = input.length > 0 && !isSearchable(input)
  const hasRecents = recents.length > 0
  return (
    <Card>
      <CardContent className="p-6">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-12">
          <div className="md:col-span-7">
            <h2 className="font-display text-xl font-semibold tracking-tight text-[#40233f]">
              How to consult the registry
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Type any U.S. street address into the search above. The registry
              looks up owner of record, the recorded chain of title, and
              current tax in a single pull. Click a recent search to reload
              its result instantly — no extra API call.
            </p>
            {showHint && (
              <p className="mt-4 text-xs italic text-muted-foreground">
                Keep typing — the search waits until there's a number and a
                street.
              </p>
            )}
          </div>
          <div className="md:col-span-5">
            <div className="flex items-baseline justify-between">
              <div className="text-[10px] font-medium uppercase tracking-wider text-[#b78625]">
                {hasRecents ? 'Recent searches' : 'Try one'}
              </div>
              {hasRecents && (
                <button
                  type="button"
                  onClick={onClearRecents}
                  className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-[#40233f]"
                >
                  Clear
                </button>
              )}
            </div>
            <ul className="mt-2 divide-y divide-border border-y border-border">
              {hasRecents
                ? recents.map((r) => (
                    <li key={r.query}>
                      <button
                        type="button"
                        onClick={() => onSuggest(r.query)}
                        className="group flex w-full items-baseline justify-between gap-3 py-2.5 text-left transition-colors"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-foreground group-hover:text-[#40233f]">
                            {r.query}
                          </span>
                          {r.ownerName && (
                            <span className="block truncate text-xs text-muted-foreground">
                              {r.ownerName}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground transition-colors group-hover:text-[#b78625]">
                          {formatRelative(r.fetchedAt)} →
                        </span>
                      </button>
                    </li>
                  ))
                : SUGGESTIONS.map((s) => (
                    <li key={s}>
                      <button
                        type="button"
                        onClick={() => onSuggest(s)}
                        className="group flex w-full items-baseline justify-between gap-3 py-2.5 text-left text-sm text-foreground transition-colors hover:text-[#40233f]"
                      >
                        <span>{s}</span>
                        <span className="font-mono text-xs text-muted-foreground transition-colors group-hover:text-[#b78625]">
                          →
                        </span>
                      </button>
                    </li>
                  ))}
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
