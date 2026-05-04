import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import {
  Plus,
  Search,
  X,
  ChevronRight,
  HelpCircle,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AppShell } from '@/components/app-shell'
import { CountyCombobox } from '@/components/county-combobox'
import { TableSkeleton } from '@/components/skeletons'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

type FilesSearch = { new?: boolean }

export const Route = createFileRoute('/files/')({
  head: () => ({
    meta: [
      { title: 'Files · Title Hub' },
      {
        name: 'description',
        content:
          'All files in your workspace, with status, parties, and reconciliation health at a glance.',
      },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!(context as { isAuthenticated?: boolean }).isAuthenticated) {
      throw redirect({ to: '/signin' })
    }
  },
  // Prefetch on hover (defaultPreload: 'intent') so the register is hot by
  // the time the user clicks. ensureQueryData reuses any cached payload
  // from a recent visit, so back-nav is instant.
  loader: ({ context }) => {
    const { queryClient } = context as { queryClient: QueryClient }
    void queryClient.ensureQueryData(convexQuery(api.files.list, {}))
    void queryClient.ensureQueryData(convexQuery(api.tenants.current, {}))
    void queryClient.ensureQueryData(convexQuery(api.seed.listIndianaCounties, {}))
  },
  validateSearch: (raw): FilesSearch => {
    const v = (raw as Record<string, unknown>).new
    const isNew = v === true || v === 'true' || v === 1 || v === '1'
    return { new: isNew || undefined }
  },
  component: FilesListPage,
})

const TX_FILTERS = [
  { id: 'all', label: 'All types' },
  { id: 'purchase', label: 'Purchase' },
  { id: 'refi', label: 'Refinance' },
  { id: 'commercial', label: 'Commercial' },
  { id: 'reo', label: 'REO' },
] as const
type TxFilter = (typeof TX_FILTERS)[number]['id']

// The lifecycle a file moves through, in order.
const STAGES: ReadonlyArray<{
  id: string
  label: string
  caption: string
}> = [
  { id: 'opened', label: 'Opened', caption: 'Just received' },
  { id: 'in_exam', label: 'In exam', caption: 'Searching title' },
  { id: 'cleared', label: 'Cleared', caption: 'Ready to close' },
  { id: 'closing', label: 'Closing', caption: 'At the table' },
  { id: 'funded', label: 'Funded', caption: 'Money disbursed' },
  { id: 'recorded', label: 'Recorded', caption: 'At the county' },
  { id: 'policied', label: 'Policy issued', caption: 'Done' },
]

// Plain-English labels for every status (including non-pipeline ones).
const STATUS_LABEL: Record<string, string> = {
  opened: 'Opened',
  in_exam: 'In exam',
  cleared: 'Cleared',
  closing: 'Closing',
  funded: 'Funded',
  recorded: 'Recorded',
  policied: 'Policy issued',
  cancelled: 'Cancelled',
}

type StageFilter = 'active' | 'done' | 'cancelled' | 'all' | string

function FilesListPage() {
  const search = Route.useSearch() as FilesSearch
  const navigate = useNavigate()
  const current = useQuery(convexQuery(api.tenants.current, {}))
  const list = useQuery(convexQuery(api.files.list, {}))
  const counties = useQuery(convexQuery(api.seed.listIndianaCounties, {}))
  const create = useConvexMutation(api.files.create)
  const seedIndiana = useConvexMutation(api.seed.indiana)

  const [showForm, setShowForm] = useState(search.new === true)
  const [txFilter, setTxFilter] = useState<TxFilter>('all')
  const [stage, setStage] = useState<StageFilter>('active')
  const [q, setQ] = useState('')
  const [showHelp, setShowHelp] = useState(false)

  useEffect(() => {
    if (search.new === true) {
      setShowForm(true)
      navigate({ to: '/files', search: {}, replace: true })
    }
  }, [search.new, navigate])

  const [fileNumber, setFileNumber] = useState('')
  const [countyId, setCountyId] = useState<Id<'counties'> | ''>('')
  const [transactionType, setTransactionType] = useState('purchase')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  if (current.data === null) {
    // No active tenant — send the user to the dashboard's org picker.
    throw redirect({ to: '/' })
  }

  if (current.error) {
    return (
      <AppShell isAuthenticated title="Files">
        <p className="text-sm text-destructive">
          Error: {current.error.message}
        </p>
      </AppShell>
    )
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!countyId) {
      setError('Pick a county.')
      return
    }
    setPending(true)
    setError(null)
    try {
      await create({
        fileNumber: fileNumber.trim(),
        countyId: countyId as Id<'counties'>,
        transactionType,
      })
      setShowForm(false)
      setFileNumber('')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg.replace(/^.*ConvexError:\s*/, ''))
    } finally {
      setPending(false)
    }
  }

  const seedIfEmpty = async () => {
    await seedIndiana({})
  }

  const allFiles = (list.data ?? []) as ReadonlyArray<FileRow>
  const countyOptions = counties.data ?? []

  const counts = useMemo(() => {
    const byStatus: Record<string, number> = {}
    for (const f of allFiles) {
      byStatus[f.status] = (byStatus[f.status] ?? 0) + 1
    }
    const active = allFiles.filter(
      (f) => f.status !== 'policied' && f.status !== 'cancelled'
    ).length
    const done = byStatus.policied ?? 0
    const cancelled = byStatus.cancelled ?? 0
    return { byStatus, active, done, cancelled, total: allFiles.length }
  }, [allFiles])

  const filtered = useMemo(() => {
    const lower = q.trim().toLowerCase()
    return allFiles.filter((f) => {
      if (txFilter !== 'all' && f.transactionType !== txFilter) return false
      if (stage === 'active') {
        if (f.status === 'policied' || f.status === 'cancelled') return false
      } else if (stage === 'done') {
        if (f.status !== 'policied') return false
      } else if (stage === 'cancelled') {
        if (f.status !== 'cancelled') return false
      } else if (stage !== 'all') {
        if (f.status !== stage) return false
      }
      if (lower) {
        const addr = f.propertyAddress
        const hay = [
          f.fileNumber,
          f.transactionType,
          f.stateCode,
          f.status,
          addr?.line1,
          addr?.city,
          addr?.zip,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!hay.includes(lower)) return false
      }
      return true
    })
  }, [allFiles, q, stage, txFilter])

  const isFirstFile = allFiles.length === 0

  return (
    <AppShell
      isAuthenticated
      title="Files"
      subtitle={
        current.data
          ? `${current.data.legalName} · ${current.data.role}`
          : undefined
      }
    >
      <div className="flex flex-col gap-6 pb-12">
        <PageHeader
          totalFiles={allFiles.length}
          actions={
            <>
              {countyOptions.length === 0 && (
                <Button variant="outline" size="sm" onClick={seedIfEmpty}>
                  Seed Indiana counties
                </Button>
              )}
              <Button onClick={() => setShowForm((s) => !s)} className="gap-2">
                {showForm ? (
                  <>
                    <X className="size-4" />
                    Cancel
                  </>
                ) : (
                  <>
                    <Plus className="size-4" />
                    New file
                  </>
                )}
              </Button>
            </>
          }
          showHelp={showHelp}
          setShowHelp={setShowHelp}
        />

        {showHelp && <HowItWorks />}

        {!isFirstFile && (
          <PipelineStrip
            counts={counts.byStatus}
            stage={stage}
            setStage={setStage}
            totals={{
              active: counts.active,
              done: counts.done,
              cancelled: counts.cancelled,
              total: counts.total,
            }}
          />
        )}

        {showForm && (
          <NewFilePanel
            fileNumber={fileNumber}
            setFileNumber={setFileNumber}
            countyId={countyId}
            setCountyId={setCountyId}
            transactionType={transactionType}
            setTransactionType={setTransactionType}
            countyOptions={countyOptions}
            onSubmit={onSubmit}
            error={error}
            pending={pending}
            onCancel={() => setShowForm(false)}
          />
        )}

        {!isFirstFile && (
          <Toolbar
            q={q}
            setQ={setQ}
            txFilter={txFilter}
            setTxFilter={setTxFilter}
            shown={filtered.length}
            total={allFiles.length}
          />
        )}

        {list.isLoading ? (
          <TableSkeleton rows={8} cols={5} />
        ) : isFirstFile ? (
          <FirstFileCoach onCreate={() => setShowForm(true)} />
        ) : filtered.length === 0 ? (
          <NoMatches
            onClear={() => {
              setQ('')
              setTxFilter('all')
              setStage('active')
            }}
          />
        ) : (
          <RegisterTable rows={filtered} />
        )}
      </div>
    </AppShell>
  )
}

function PageHeader({
  totalFiles,
  actions,
  showHelp,
  setShowHelp,
}: {
  totalFiles: number
  actions?: React.ReactNode
  showHelp: boolean
  setShowHelp: (b: boolean) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl leading-[1] font-semibold tracking-tight text-[#40233f] md:text-5xl">
            Files
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            One file per property transaction. Each one tracks the work from{' '}
            <strong className="font-medium text-[#40233f]">opened</strong> all
            the way to{' '}
            <strong className="font-medium text-[#40233f]">
              policy issued
            </strong>
            . Click any row below to open its docket.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowHelp(!showHelp)}
            className="flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-xs text-muted-foreground ring-1 ring-border/70 transition hover:text-[#40233f]"
          >
            <HelpCircle className="size-3.5" />
            {showHelp ? 'Hide' : 'How files work'}
          </button>
          {actions}
        </div>
      </div>
      {totalFiles > 0 && (
        <div className="font-numerals text-xs text-muted-foreground tabular-nums">
          {totalFiles} file{totalFiles === 1 ? '' : 's'} of record
        </div>
      )}
    </div>
  )
}

function HowItWorks() {
  return (
    <div className="rounded-2xl border border-border/70 bg-[#fdf6e8]/60 px-6 py-5 ring-1 ring-foreground/5">
      <div className="flex items-center gap-2 text-xs font-medium text-[#b78625]">
        <HelpCircle className="size-3.5" />
        How files work
      </div>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-foreground/85">
        A <strong className="font-medium">file</strong> is the record for a
        single real-estate transaction. You open it when you receive an order,
        examine title, clear any defects, close at the table, fund, record at
        the county, and finally issue a policy. The seven stages below run in
        order. A file can also be{' '}
        <strong className="font-medium">cancelled</strong> at any point.
      </p>
      <ol className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-4">
        {STAGES.map((s, i) => (
          <li key={s.id} className="flex items-start gap-2">
            <span className="font-numerals mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-card text-xs font-semibold text-[#40233f] tabular-nums ring-1 ring-border">
              {i + 1}
            </span>
            <div className="min-w-0">
              <div className="text-xs font-medium text-[#40233f]">
                {s.label}
              </div>
              <div className="text-xs leading-snug text-muted-foreground">
                {s.caption}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function PipelineStrip({
  counts,
  stage,
  setStage,
  totals,
}: {
  counts: Record<string, number>
  stage: StageFilter
  setStage: (s: StageFilter) => void
  totals: { active: number; done: number; cancelled: number; total: number }
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span>Filter by stage</span>
        <span aria-hidden className="h-px flex-1 bg-border/70" />
      </div>

      <div className="flex flex-wrap items-stretch gap-2">
        <button
          type="button"
          onClick={() => setStage('active')}
          className={`group/all flex flex-col items-start gap-0.5 rounded-xl border px-4 py-2.5 text-left transition ${
            stage === 'active'
              ? 'border-[#40233f] bg-[#40233f] text-[#f6e8d9]'
              : 'border-border/70 bg-card text-[#40233f] hover:border-[#40233f]/50'
          }`}
          aria-pressed={stage === 'active'}
        >
          <span
            className={`text-xs font-medium ${
              stage === 'active' ? 'text-[#f4d48f]' : 'text-[#b78625]'
            }`}
          >
            Active
          </span>
          <span className="font-display text-2xl leading-none font-semibold tabular-nums">
            {String(totals.active).padStart(2, '0')}
          </span>
          <span
            className={`text-xs leading-snug ${
              stage === 'active' ? 'text-white/70' : 'text-muted-foreground'
            }`}
          >
            in progress
          </span>
        </button>

        <div className="flex flex-1 items-stretch overflow-hidden rounded-xl border border-border/70 bg-card ring-1 ring-foreground/5">
          {STAGES.filter((s) => s.id !== 'policied').map((s, i, arr) => {
            const n = counts[s.id] ?? 0
            const selected = stage === s.id
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setStage(selected ? 'active' : s.id)}
                className={`group/stage relative flex flex-1 flex-col items-start gap-0.5 px-3 py-2.5 text-left transition ${
                  selected
                    ? 'bg-[#40233f] text-[#f6e8d9]'
                    : 'hover:bg-[#fdf6e8]/60'
                } ${i < arr.length - 1 ? 'border-r border-border/60' : ''}`}
                aria-pressed={selected}
                title={`${s.label} — ${s.caption}`}
              >
                <span
                  className={`text-xs font-medium ${
                    selected ? 'text-[#f4d48f]' : 'text-muted-foreground'
                  }`}
                >
                  {i + 1} · {s.label}
                </span>
                <span
                  className={`font-display text-xl leading-none font-semibold tabular-nums ${
                    selected
                      ? ''
                      : n > 0
                        ? 'text-[#40233f]'
                        : 'text-muted-foreground/40'
                  }`}
                >
                  {String(n).padStart(2, '0')}
                </span>
              </button>
            )
          })}
        </div>

        <button
          type="button"
          onClick={() => setStage('done')}
          className={`flex flex-col items-start gap-0.5 rounded-xl border px-4 py-2.5 text-left transition ${
            stage === 'done'
              ? 'border-[#3f7c64] bg-[#e6f3ed] text-[#2f5d4b]'
              : 'border-border/70 bg-card text-[#2f5d4b] hover:border-[#3f7c64]/40'
          }`}
          aria-pressed={stage === 'done'}
        >
          <span className="flex items-center gap-1 text-xs font-medium text-[#3f7c64]">
            <CheckCircle2 className="size-3" />
            Policied
          </span>
          <span className="font-display text-2xl leading-none font-semibold tabular-nums">
            {String(totals.done).padStart(2, '0')}
          </span>
          <span className="text-xs leading-snug text-[#3f7c64]/80">
            closed out
          </span>
        </button>

        <button
          type="button"
          onClick={() => setStage('cancelled')}
          className={`flex flex-col items-start gap-0.5 rounded-xl border px-4 py-2.5 text-left transition ${
            stage === 'cancelled'
              ? 'border-[#b94f58] bg-[#fdecee] text-[#8a3942]'
              : 'border-border/70 bg-card text-[#8a3942] hover:border-[#b94f58]/40'
          }`}
          aria-pressed={stage === 'cancelled'}
        >
          <span className="flex items-center gap-1 text-xs font-medium text-[#b94f58]">
            <XCircle className="size-3" />
            Cancelled
          </span>
          <span className="font-display text-2xl leading-none font-semibold tabular-nums">
            {String(totals.cancelled).padStart(2, '0')}
          </span>
          <span className="text-xs leading-snug text-[#b94f58]/80">
            walked away
          </span>
        </button>

        <button
          type="button"
          onClick={() => setStage('all')}
          className={`flex flex-col items-start gap-0.5 rounded-xl border px-4 py-2.5 text-left transition ${
            stage === 'all'
              ? 'border-[#40233f] bg-card text-[#40233f]'
              : 'border-border/70 bg-card text-muted-foreground hover:border-[#40233f]/40 hover:text-[#40233f]'
          }`}
          aria-pressed={stage === 'all'}
        >
          <span className="text-xs font-medium">All</span>
          <span className="font-display text-2xl leading-none font-semibold tabular-nums">
            {String(totals.total).padStart(2, '0')}
          </span>
          <span className="text-xs leading-snug">show everything</span>
        </button>
      </div>
    </div>
  )
}

function Toolbar({
  q,
  setQ,
  txFilter,
  setTxFilter,
  shown,
  total,
}: {
  q: string
  setQ: (s: string) => void
  txFilter: TxFilter
  setTxFilter: (t: TxFilter) => void
  shown: number
  total: number
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-1 rounded-full bg-card p-1 ring-1 ring-border/70">
        {TX_FILTERS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTxFilter(t.id)}
            className={`rounded-full px-3 py-1 text-xs transition ${
              txFilter === t.id
                ? 'bg-[#40233f] text-[#f6e8d9] shadow-sm'
                : 'text-muted-foreground hover:text-[#40233f]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <label className="relative ml-auto flex w-full items-center gap-2 rounded-full bg-card px-3.5 py-1.5 ring-1 ring-border/70 focus-within:ring-2 focus-within:ring-[#593157]/30 sm:w-72">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search file #, address, county..."
          className="font-numerals w-full bg-transparent text-xs text-[#2e2430] placeholder:text-muted-foreground/60 focus:outline-none"
        />
        {q && (
          <button
            type="button"
            onClick={() => setQ('')}
            className="rounded-full p-0.5 text-muted-foreground hover:text-[#40233f]"
            aria-label="Clear"
          >
            <X className="size-3" />
          </button>
        )}
      </label>

      <span className="font-numerals text-xs text-muted-foreground tabular-nums">
        Showing {shown} of {total}
      </span>
    </div>
  )
}

type FileRow = {
  _id: string
  fileNumber: string
  transactionType: string
  stateCode: string
  status: string
  openedAt: number
  targetCloseDate?: number
  propertyAddress?: {
    line1: string
    line2?: string
    city: string
    state: string
    zip: string
  }
}

function RegisterTable({ rows }: { rows: ReadonlyArray<FileRow> }) {
  return (
    <article className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/5">
      {/* Column headers — only render at md+ where the full grid layout
          actually fits. On mobile, rows render as stacked cards instead. */}
      <div className="hidden grid-cols-[minmax(0,1fr)_7rem_5.5rem_6rem_7rem_2rem] items-center gap-4 border-b border-border/70 bg-[#fdf6e8]/70 px-6 py-2.5 text-xs text-muted-foreground md:grid">
        <span>File &amp; property</span>
        <span>Type</span>
        <span>County</span>
        <span>Opened</span>
        <span>Status</span>
        <span />
      </div>

      <ol className="divide-y divide-border/50">
        {rows.map((f) => {
          const days = Math.floor(
            (Date.now() - f.openedAt) / (24 * 3600 * 1000)
          )
          const addr = f.propertyAddress
          const addrText = addr
            ? `${addr.line1}${addr.city ? ` · ${addr.city}, ${addr.state}` : ''}`
            : null
          const openedDate = new Date(f.openedAt).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
          })
          const opened = days === 0 ? 'today' : `${days}d ago`
          return (
            <li key={f._id}>
              <Link
                to="/files/$fileId"
                params={{ fileId: f._id }}
                className="group/row grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-4 py-3 transition hover:bg-[#fdf6e8]/50 md:grid-cols-[minmax(0,1fr)_7rem_5.5rem_6rem_7rem_2rem] md:items-center md:gap-4 md:px-6 md:py-3.5"
              >
                <div className="min-w-0">
                  <div className="font-numerals truncate text-sm font-medium tracking-tight text-[#2e2430] group-hover/row:text-[#40233f]">
                    {f.fileNumber}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {addrText ?? 'No property on file yet'}
                  </div>
                  {/* Mobile-only meta line. Hidden once the full grid layout
                      kicks in at md, where these values get their own cells. */}
                  <div className="font-numerals mt-1 truncate text-[11px] text-muted-foreground/80 md:hidden">
                    <span className="capitalize">{f.transactionType}</span>
                    {' · '}
                    {f.stateCode}
                    {' · '}
                    {openedDate} ({opened})
                  </div>
                </div>

                <div className="hidden text-xs text-foreground/85 capitalize md:block">
                  {f.transactionType}
                </div>

                <div className="font-numerals hidden text-xs text-muted-foreground md:block">
                  {f.stateCode}
                </div>

                <div className="hidden min-w-0 md:block">
                  <div className="text-xs text-foreground/85">{openedDate}</div>
                  <div className="font-numerals text-xs text-muted-foreground tabular-nums">
                    {opened}
                  </div>
                </div>

                <div className="self-center md:self-auto">
                  <StatusStamp status={f.status} />
                </div>

                <ChevronRight className="hidden size-3.5 text-muted-foreground/40 transition group-hover/row:translate-x-0.5 group-hover/row:text-[#40233f] md:inline" />
              </Link>
            </li>
          )
        })}
      </ol>
    </article>
  )
}

function NewFilePanel({
  fileNumber,
  setFileNumber,
  countyId,
  setCountyId,
  transactionType,
  setTransactionType,
  countyOptions,
  onSubmit,
  error,
  pending,
  onCancel,
}: {
  fileNumber: string
  setFileNumber: (s: string) => void
  countyId: Id<'counties'> | ''
  setCountyId: (id: Id<'counties'>) => void
  transactionType: string
  setTransactionType: (s: string) => void
  countyOptions: ReadonlyArray<{
    _id: Id<'counties'>
    name: string
    stateCode: string
  }>
  onSubmit: (e: React.FormEvent) => void
  error: string | null
  pending: boolean
  onCancel: () => void
}) {
  // Pull the active tenant's file-number policy. If a pattern is configured,
  // an empty `fileNumber` is allowed and the server will assign one — the
  // placeholder previews what they'll get.
  const policy = useQuery(convexQuery(api.fileNumberPolicy.get, {}))
  const preview = useQuery(
    convexQuery(api.fileNumberPolicy.previewBatch, {
      count: 1,
      countyId: (countyId || undefined) as Id<'counties'> | undefined,
      transactionType,
    }),
  )

  const policyConfigured = policy.data?.isCustomized === true
  const suggestion = preview.data?.previews?.[0] ?? null
  const trimmed = fileNumber.trim()
  const hasFileNumber = trimmed.length > 0
  const usingAuto = policyConfigured && !hasFileNumber
  const submitDisabled =
    pending || !countyId || (!hasFileNumber && !policyConfigured)

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm ring-1 ring-foreground/5">
      <header className="flex items-center justify-between border-b border-border/60 bg-[#fdf6e8] px-6 py-3.5">
        <div className="flex items-center gap-3">
          <div className="grid size-8 place-items-center rounded-md border border-[#40233f]/20 bg-card font-display text-xs font-semibold text-[#40233f]">
            №
          </div>
          <div>
            <div className="font-display text-base font-semibold tracking-tight text-[#40233f]">
              Open a new file
            </div>
            <div className="text-xs text-muted-foreground">
              Three things to start. You can fill in the rest later.
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="grid size-8 place-items-center rounded-full text-muted-foreground transition hover:bg-card hover:text-[#40233f]"
          aria-label="Cancel"
        >
          <X className="size-4" />
        </button>
      </header>

      <form onSubmit={onSubmit} className="grid gap-5 px-6 py-5 md:grid-cols-3">
        <Field
          label="File number"
          hint={
            policyConfigured
              ? `Auto-assigned from ${policy.data!.pattern}. Type to override.`
              : "Your firm's reference, e.g. QT-2026-0001"
          }
          required={!policyConfigured}
        >
          <div className="relative">
            <Input
              placeholder={suggestion ?? 'QT-2026-0001'}
              value={fileNumber}
              onChange={(e) => setFileNumber(e.target.value)}
              required={!policyConfigured}
              className="font-numerals pr-24"
            />
            {usingAuto && suggestion && (
              <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-full bg-[#fdf6e8] px-2 py-0.5 text-[10px] font-semibold tracking-wide text-[#7a5818]">
                AUTO
              </span>
            )}
            {!usingAuto && policyConfigured && suggestion && (
              <button
                type="button"
                onClick={() => setFileNumber('')}
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-full bg-card px-2 py-0.5 text-[10px] font-medium text-[#593157] transition hover:bg-[#f1eaf3]"
                title="Use the next auto-assigned number"
              >
                Use suggested
              </button>
            )}
          </div>
        </Field>
        <Field label="County" hint="Where it will be recorded" required>
          <CountyCombobox
            counties={countyOptions}
            value={countyId}
            onChange={setCountyId}
          />
        </Field>
        <Field label="Transaction type" hint="Picks the right rules">
          <Select value={transactionType} onValueChange={setTransactionType}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="purchase">Purchase</SelectItem>
              <SelectItem value="refi">Refinance</SelectItem>
              <SelectItem value="commercial">Commercial</SelectItem>
              <SelectItem value="reo">REO</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {error && (
          <p className="rounded-md border border-[#b94f58]/30 bg-[#fdecee] px-3 py-2 text-sm text-[#8a3942] md:col-span-3">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 md:col-span-3">
          <div className="text-xs text-muted-foreground">
            <span className="text-[#b94f58]">*</span> required.{' '}
            {!hasFileNumber && !policyConfigured && 'Add a file number. '}
            {!countyId && 'Pick a county.'}
            {usingAuto && suggestion && (
              <span>
                Will be assigned{' '}
                <span className="font-mono text-[#40233f]">{suggestion}</span>.
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitDisabled}>
              {pending ? 'Opening...' : 'Open file'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  )
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string
  hint?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-[#40233f]">
        {label}
        {required && (
          <span className="ml-1 text-[#b94f58]" aria-hidden>
            *
          </span>
        )}
      </span>
      {children}
      {hint && (
        <span className="text-xs leading-snug text-muted-foreground">
          {hint}
        </span>
      )}
    </label>
  )
}

function StatusStamp({ status }: { status: string }) {
  const tone =
    status === 'policied'
      ? {
          ring: 'ring-[#3f7c64]/40',
          text: 'text-[#2f5d4b]',
          bg: 'bg-[#e6f3ed]',
          dot: 'bg-[#3f7c64]',
        }
      : status === 'closing' || status === 'funded' || status === 'recorded'
        ? {
            ring: 'ring-[#b78625]/45',
            text: 'text-[#7a5818]',
            bg: 'bg-[#f8eed7]',
            dot: 'bg-[#b78625]',
          }
        : status === 'cleared'
          ? {
              ring: 'ring-[#3f668f]/40',
              text: 'text-[#2c4a6b]',
              bg: 'bg-[#e8f0f8]',
              dot: 'bg-[#3f668f]',
            }
          : status === 'in_exam' || status === 'opened'
            ? {
                ring: 'ring-[#593157]/35',
                text: 'text-[#40233f]',
                bg: 'bg-[#f2e7f1]',
                dot: 'bg-[#593157]',
              }
            : status === 'cancelled'
              ? {
                  ring: 'ring-[#b94f58]/45',
                  text: 'text-[#8a3942]',
                  bg: 'bg-[#fdecee]',
                  dot: 'bg-[#b94f58]',
                }
              : {
                  ring: 'ring-border',
                  text: 'text-muted-foreground',
                  bg: 'bg-muted',
                  dot: 'bg-muted-foreground',
                }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ring-1 ring-inset ${tone.ring} ${tone.text} ${tone.bg}`}
    >
      <span className={`size-1.5 rounded-full ${tone.dot}`} />
      {STATUS_LABEL[status] ?? status.replace(/_/g, ' ')}
    </span>
  )
}

function FirstFileCoach({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm ring-1 ring-foreground/5">
      <div className="grid grid-cols-1 gap-6 p-5 sm:gap-8 sm:p-8 md:grid-cols-[1.2fr_1fr] md:p-10">
        <div>
          <div className="text-xs font-medium text-[#b78625]">Get started</div>
          <h2 className="mt-2 font-display text-3xl leading-tight font-semibold tracking-tight text-[#40233f]">
            Open your first file
          </h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
            A file represents one property transaction. Once you open it, you
            can attach documents, list parties, and run reconciliation against
            the county's recording rules.
          </p>
          <Button onClick={onCreate} className="mt-5 gap-2">
            <Plus className="size-4" />
            New file
          </Button>
          <div className="mt-3 text-xs text-muted-foreground">
            Takes about ten seconds.
          </div>
        </div>

        <ol className="flex flex-col gap-3">
          {[
            {
              n: 1,
              t: 'Give it a file number',
              d: "Your firm's existing reference works fine, e.g. QT-2026-0001.",
            },
            {
              n: 2,
              t: 'Pick the county',
              d: 'We use this to apply the right recording rules.',
            },
            {
              n: 3,
              t: 'Choose a transaction type',
              d: 'Purchase, refi, commercial, or REO.',
            },
            {
              n: 4,
              t: 'Work it through the stages',
              d: 'Opened → exam → cleared → closing → funded → recorded → policy.',
            },
          ].map((s) => (
            <li
              key={s.n}
              className="flex items-start gap-3 rounded-xl border border-border/60 bg-[#fdf6e8]/40 px-4 py-3"
            >
              <span className="font-numerals grid size-7 shrink-0 place-items-center rounded-full bg-[#40233f] text-xs font-semibold text-[#f4d48f] tabular-nums">
                {s.n}
              </span>
              <div className="min-w-0">
                <div className="text-sm font-medium text-[#40233f]">{s.t}</div>
                <div className="text-[12px] leading-snug text-muted-foreground">
                  {s.d}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className="rounded-2xl border border-border/60 bg-card/60 px-8 py-14 text-center shadow-sm ring-1 ring-foreground/5">
      <div className="text-2xl font-semibold text-[#40233f]">
        Nothing matches those filters.
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Try a broader stage, a different transaction type, or clear the search.
      </p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onClear}>
        Reset filters
      </Button>
    </div>
  )
}
