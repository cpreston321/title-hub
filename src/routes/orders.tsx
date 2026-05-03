import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  FileWarning,
  Inbox,
  Search,
  ShieldAlert,
  Sparkles,
  TimerReset,
  X,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AppShell } from '@/components/app-shell'
import { useConfirm } from '@/components/confirm-dialog'
import { Loading } from '@/components/loading'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'

export const Route = createFileRoute('/orders')({
  head: () => ({
    meta: [
      { title: 'Order management · Title Hub' },
      {
        name: 'description',
        content:
          'Triage incoming orders — see source, completeness, and findings before sending a file into exam.',
      },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!(context as { isAuthenticated?: boolean }).isAuthenticated) {
      throw redirect({ to: '/signin' })
    }
  },
  component: OrdersPage,
})

type OrderSource = 'manual' | 'softpro' | 'qualia' | 'resware'
type OrderStatus = 'opened' | 'in_exam'

type OrderRow = {
  _id: Id<'files'>
  fileNumber: string
  status: OrderStatus
  stateCode: string
  countyName: string | null
  transactionType: string
  propertyAddress: {
    line1: string
    line2?: string
    city: string
    state: string
    zip: string
  } | null
  propertyApn: string | null
  openedAt: number
  targetCloseDate: number | null
  source: OrderSource
  externalId: string | null
  partyCount: number
  documentCount: number
  extractionCounts: {
    pending: number
    running: number
    succeeded: number
    failed: number
  }
  findingCounts: { block: number; warn: number; info: number }
  findingTotal: number
}

const SOURCE_LABELS: Record<OrderSource, string> = {
  manual: 'Manual',
  softpro: 'SoftPro',
  qualia: 'Qualia',
  resware: 'ResWare',
}

const SOURCE_FILTERS: ReadonlyArray<{
  id: 'all' | OrderSource
  label: string
}> = [
  { id: 'all', label: 'All sources' },
  { id: 'manual', label: 'Manual' },
  { id: 'softpro', label: 'SoftPro' },
  { id: 'qualia', label: 'Qualia' },
  { id: 'resware', label: 'ResWare' },
]

const STATUS_FILTERS: ReadonlyArray<{
  id: 'all' | OrderStatus
  label: string
}> = [
  { id: 'all', label: 'New + in exam' },
  { id: 'opened', label: 'New' },
  { id: 'in_exam', label: 'In exam' },
]

function OrdersPage() {
  const navigate = useNavigate()
  const current = useQuery(convexQuery(api.tenants.current, {}))
  const list = useQuery(convexQuery(api.orders.list, {}))
  const summary = useQuery(convexQuery(api.orders.summary, {}))

  const advance = useConvexMutation(api.orders.advanceToExam)
  const cancel = useConvexMutation(api.orders.cancel)
  const confirm = useConfirm()

  const [sourceFilter, setSourceFilter] = useState<'all' | OrderSource>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | OrderStatus>('all')
  const [q, setQ] = useState('')
  const [busyId, setBusyId] = useState<Id<'files'> | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (current.data === null) {
    throw redirect({ to: '/' })
  }

  if (current.error) {
    return (
      <AppShell isAuthenticated title="Order management">
        <p className="text-sm text-destructive">
          Error: {current.error.message}
        </p>
      </AppShell>
    )
  }

  const orders = (list.data ?? []) as ReadonlyArray<OrderRow>

  const filtered = useMemo(() => {
    const lower = q.trim().toLowerCase()
    return orders.filter((o) => {
      if (sourceFilter !== 'all' && o.source !== sourceFilter) return false
      if (statusFilter !== 'all' && o.status !== statusFilter) return false
      if (lower) {
        const hay = [
          o.fileNumber,
          o.transactionType,
          o.stateCode,
          o.countyName,
          o.externalId,
          o.propertyAddress?.line1,
          o.propertyAddress?.city,
          o.propertyAddress?.zip,
          o.propertyApn,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!hay.includes(lower)) return false
      }
      return true
    })
  }, [orders, q, sourceFilter, statusFilter])

  const onAdvance = async (fileId: Id<'files'>) => {
    setBusyId(fileId)
    setError(null)
    try {
      await advance({ fileId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg.replace(/^.*ConvexError:\s*/, ''))
    } finally {
      setBusyId(null)
    }
  }

  const onCancel = async (fileId: Id<'files'>) => {
    const ok = await confirm({
      title: 'Cancel this order?',
      description: 'You can reopen it later if needed.',
      confirmText: 'Cancel order',
      cancelText: 'Keep open',
      destructive: true,
    })
    if (!ok) return
    setBusyId(fileId)
    setError(null)
    try {
      await cancel({ fileId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg.replace(/^.*ConvexError:\s*/, ''))
    } finally {
      setBusyId(null)
    }
  }

  const isLoading = list.isLoading
  const isEmpty = !isLoading && orders.length === 0

  return (
    <AppShell
      isAuthenticated
      title="Order management"
      subtitle={
        current.data
          ? `${current.data.legalName} · ${current.data.role}`
          : undefined
      }
    >
      <div className="flex flex-col gap-6 pb-12">
        <PageHeader />

        {summary.data && !isEmpty && (
          <KpiStrip
            data={summary.data as SummaryShape}
            onJumpStale={() => {
              setStatusFilter('all')
              setSourceFilter('all')
            }}
          />
        )}

        {!isEmpty && (
          <Toolbar
            q={q}
            setQ={setQ}
            sourceFilter={sourceFilter}
            setSourceFilter={setSourceFilter}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            shown={filtered.length}
            total={orders.length}
          />
        )}

        {error && (
          <div className="rounded-md border border-[#b94f58]/30 bg-[#fdecee] px-3 py-2 text-sm text-[#8a3942]">
            {error}
          </div>
        )}

        {isLoading ? (
          <Loading block label="Pulling the inbox" />
        ) : isEmpty ? (
          <EmptyState onCreate={() => navigate({ to: '/files', search: { new: true } })} />
        ) : filtered.length === 0 ? (
          <NoMatches
            onClear={() => {
              setQ('')
              setSourceFilter('all')
              setStatusFilter('all')
            }}
          />
        ) : (
          <OrderList
            rows={filtered}
            busyId={busyId}
            onAdvance={onAdvance}
            onCancel={onCancel}
          />
        )}
      </div>
    </AppShell>
  )
}

type SummaryShape = {
  total: number
  bySource: Record<OrderSource, number>
  byStatus: { opened: number; in_exam: number }
  staleCount: number
  withoutPartiesCount: number
}

function PageHeader() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl leading-[1] font-semibold tracking-tight text-[#40233f] md:text-5xl">
            Order management
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            New orders land here — manual openings and integration syncs alike.
            Triage them, send the clean ones into exam, and cancel the noise.
          </p>
        </div>
        <Button asChild variant="outline" size="sm" className="gap-2">
          <Link to="/files" search={{ new: true }}>
            New manual order
          </Link>
        </Button>
      </div>
    </div>
  )
}

function KpiStrip({
  data,
  onJumpStale,
}: {
  data: SummaryShape
  onJumpStale: () => void
}) {
  const tiles: ReadonlyArray<{
    label: string
    value: number
    caption: string
    icon: React.ReactNode
    accent: string
    onClick?: () => void
  }> = [
    {
      label: 'In the queue',
      value: data.total,
      caption: `${data.byStatus.opened} new · ${data.byStatus.in_exam} in exam`,
      icon: <Inbox className="size-3.5" />,
      accent: 'text-[#40233f]',
    },
    {
      label: 'No parties yet',
      value: data.withoutPartiesCount,
      caption: 'Need intake info',
      icon: <FileWarning className="size-3.5" />,
      accent: 'text-[#7a3d18]',
    },
    {
      label: 'Stale (>7d)',
      value: data.staleCount,
      caption: 'Open longer than a week',
      icon: <TimerReset className="size-3.5" />,
      accent: 'text-[#8a3942]',
      onClick: onJumpStale,
    },
    {
      label: 'From integrations',
      value:
        data.bySource.softpro + data.bySource.qualia + data.bySource.resware,
      caption: `${data.bySource.softpro} SoftPro · ${data.bySource.qualia} Qualia · ${data.bySource.resware} ResWare`,
      icon: <Sparkles className="size-3.5" />,
      accent: 'text-[#2c4a6b]',
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map((t) => (
        <div
          key={t.label}
          className="flex flex-col gap-1 rounded-2xl border border-border/70 bg-card px-4 py-3 shadow-sm ring-1 ring-foreground/5"
        >
          <div className={`flex items-center gap-1.5 text-xs font-medium ${t.accent}`}>
            {t.icon}
            {t.label}
          </div>
          <div className="font-display text-2xl leading-none font-semibold tabular-nums text-[#40233f]">
            {String(t.value).padStart(2, '0')}
          </div>
          <div className="text-xs text-muted-foreground">{t.caption}</div>
        </div>
      ))}
    </div>
  )
}

function Toolbar({
  q,
  setQ,
  sourceFilter,
  setSourceFilter,
  statusFilter,
  setStatusFilter,
  shown,
  total,
}: {
  q: string
  setQ: (s: string) => void
  sourceFilter: 'all' | OrderSource
  setSourceFilter: (s: 'all' | OrderSource) => void
  statusFilter: 'all' | OrderStatus
  setStatusFilter: (s: 'all' | OrderStatus) => void
  shown: number
  total: number
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-full bg-card p-1 ring-1 ring-border/70">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setStatusFilter(s.id)}
              className={`rounded-full px-3 py-1 text-xs transition ${
                statusFilter === s.id
                  ? 'bg-[#40233f] text-[#f6e8d9] shadow-sm'
                  : 'text-muted-foreground hover:text-[#40233f]'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 rounded-full bg-card p-1 ring-1 ring-border/70">
          {SOURCE_FILTERS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSourceFilter(s.id)}
              className={`rounded-full px-3 py-1 text-xs transition ${
                sourceFilter === s.id
                  ? 'bg-[#40233f] text-[#f6e8d9] shadow-sm'
                  : 'text-muted-foreground hover:text-[#40233f]'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <label className="relative ml-auto flex w-full items-center gap-2 rounded-full bg-card px-3.5 py-1.5 ring-1 ring-border/70 focus-within:ring-2 focus-within:ring-[#593157]/30 sm:w-72">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search file #, address, external id..."
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
    </div>
  )
}

function OrderList({
  rows,
  busyId,
  onAdvance,
  onCancel,
}: {
  rows: ReadonlyArray<OrderRow>
  busyId: Id<'files'> | null
  onAdvance: (id: Id<'files'>) => void
  onCancel: (id: Id<'files'>) => void
}) {
  return (
    <ol className="flex flex-col gap-3">
      {rows.map((o) => (
        <OrderCard
          key={o._id}
          order={o}
          busy={busyId === o._id}
          onAdvance={() => onAdvance(o._id)}
          onCancel={() => onCancel(o._id)}
        />
      ))}
    </ol>
  )
}

function OrderCard({
  order,
  busy,
  onAdvance,
  onCancel,
}: {
  order: OrderRow
  busy: boolean
  onAdvance: () => void
  onCancel: () => void
}) {
  const days = Math.floor((Date.now() - order.openedAt) / (24 * 3600 * 1000))
  const addr = order.propertyAddress
  const addrText = addr
    ? `${addr.line1}${addr.city ? ` · ${addr.city}, ${addr.state} ${addr.zip}` : ''}`
    : null
  const stale = days > 7
  const blocking = order.findingCounts.block

  return (
    <li className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm ring-1 ring-foreground/5">
      <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
        <div className="min-w-0 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/files/$fileId"
              params={{ fileId: order._id }}
              className="font-numerals text-base font-semibold tracking-tight text-[#40233f] transition hover:underline"
            >
              {order.fileNumber}
            </Link>
            <SourceBadge source={order.source} externalId={order.externalId} />
            <StatusPill status={order.status} />
            <span className="text-xs capitalize text-muted-foreground">
              {order.transactionType}
            </span>
            <span className="text-xs text-muted-foreground">
              · {order.countyName ?? '—'}, {order.stateCode}
            </span>
            {stale && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[#fdecee] px-2 py-0.5 text-[11px] font-medium text-[#8a3942] ring-1 ring-inset ring-[#b94f58]/30">
                <TimerReset className="size-3" />
                {days}d open
              </span>
            )}
          </div>

          <div className="text-sm text-foreground/85">
            {addrText ?? (
              <span className="text-muted-foreground italic">
                No property on file yet
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Stat label="Parties" n={order.partyCount} warnIf={(v) => v === 0} />
            <Stat label="Docs" n={order.documentCount} warnIf={(v) => v === 0} />
            <ExtractionStat counts={order.extractionCounts} />
            <FindingStat counts={order.findingCounts} total={order.findingTotal} />
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-stretch gap-2 md:w-44">
          <Button asChild variant="outline" size="sm" className="justify-between">
            <Link to="/files/$fileId" params={{ fileId: order._id }}>
              Open file
              <ChevronRight className="size-3.5" />
            </Link>
          </Button>
          {order.status === 'opened' ? (
            <Button
              size="sm"
              onClick={onAdvance}
              disabled={busy || blocking > 0}
              title={
                blocking > 0
                  ? 'Resolve blocking findings before sending to exam.'
                  : undefined
              }
              className="gap-2"
            >
              <CheckCircle2 className="size-3.5" />
              {busy ? 'Working...' : 'Send to exam'}
            </Button>
          ) : (
            <Button size="sm" disabled variant="secondary" className="gap-2">
              <CheckCircle2 className="size-3.5" />
              In exam
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={onCancel}
            disabled={busy}
            className="gap-2 text-muted-foreground hover:text-[#8a3942]"
          >
            <XCircle className="size-3.5" />
            Cancel order
          </Button>
        </div>
      </div>
    </li>
  )
}

function SourceBadge({
  source,
  externalId,
}: {
  source: OrderSource
  externalId: string | null
}) {
  const tone =
    source === 'manual'
      ? 'bg-[#f2e7f1] text-[#40233f] ring-[#593157]/25'
      : source === 'softpro'
        ? 'bg-[#e8f0f8] text-[#2c4a6b] ring-[#3f668f]/30'
        : source === 'qualia'
          ? 'bg-[#e6f3ed] text-[#2f5d4b] ring-[#3f7c64]/30'
          : 'bg-[#f8eed7] text-[#7a5818] ring-[#b78625]/30'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tone}`}
      title={externalId ? `External id: ${externalId}` : undefined}
    >
      {SOURCE_LABELS[source]}
      {externalId && (
        <span className="font-numerals text-[10px] opacity-70">
          · {truncate(externalId, 14)}
        </span>
      )}
    </span>
  )
}

function StatusPill({ status }: { status: OrderStatus }) {
  if (status === 'opened') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#fdf6e8] px-2 py-0.5 text-[11px] font-medium text-[#7a5818] ring-1 ring-inset ring-[#b78625]/30">
        <Sparkles className="size-3" />
        New
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#e8f0f8] px-2 py-0.5 text-[11px] font-medium text-[#2c4a6b] ring-1 ring-inset ring-[#3f668f]/30">
      In exam
    </span>
  )
}

function Stat({
  label,
  n,
  warnIf,
}: {
  label: string
  n: number
  warnIf?: (n: number) => boolean
}) {
  const warn = warnIf?.(n) ?? false
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ring-1 ring-inset ${
        warn
          ? 'bg-[#fdecee] text-[#8a3942] ring-[#b94f58]/30'
          : 'bg-card text-foreground/80 ring-border/70'
      }`}
    >
      <span className="font-numerals tabular-nums">{n}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  )
}

function ExtractionStat({
  counts,
}: {
  counts: { pending: number; running: number; succeeded: number; failed: number }
}) {
  const inflight = counts.pending + counts.running
  if (counts.failed > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#fdecee] px-2 py-0.5 text-[#8a3942] ring-1 ring-inset ring-[#b94f58]/30">
        <AlertTriangle className="size-3" />
        <span className="font-numerals tabular-nums">{counts.failed}</span>
        <span>extract failed</span>
      </span>
    )
  }
  if (inflight > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#fdf6e8] px-2 py-0.5 text-[#7a5818] ring-1 ring-inset ring-[#b78625]/30">
        <Sparkles className="size-3 animate-pulse" />
        <span className="font-numerals tabular-nums">{inflight}</span>
        <span>extracting</span>
      </span>
    )
  }
  if (counts.succeeded > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#e6f3ed] px-2 py-0.5 text-[#2f5d4b] ring-1 ring-inset ring-[#3f7c64]/30">
        <CheckCircle2 className="size-3" />
        <span className="font-numerals tabular-nums">{counts.succeeded}</span>
        <span>extracted</span>
      </span>
    )
  }
  return null
}

function FindingStat({
  counts,
  total,
}: {
  counts: { block: number; warn: number; info: number }
  total: number
}) {
  if (total === 0) return null
  if (counts.block > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#fdecee] px-2 py-0.5 text-[#8a3942] ring-1 ring-inset ring-[#b94f58]/30">
        <ShieldAlert className="size-3" />
        <span className="font-numerals tabular-nums">{counts.block}</span>
        <span>blocking</span>
      </span>
    )
  }
  if (counts.warn > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#fde9dc] px-2 py-0.5 text-[#7a3d18] ring-1 ring-inset ring-[#b78625]/30">
        <AlertTriangle className="size-3" />
        <span className="font-numerals tabular-nums">{counts.warn}</span>
        <span>warn</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-card px-2 py-0.5 text-foreground/80 ring-1 ring-inset ring-border/70">
      <span className="font-numerals tabular-nums">{counts.info}</span>
      <span>info</span>
    </span>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-2xl border border-border/60 bg-card/60 px-8 py-14 text-center shadow-sm ring-1 ring-foreground/5">
      <Inbox className="mx-auto size-6 text-muted-foreground/60" />
      <div className="mt-3 font-display text-2xl font-semibold text-[#40233f]">
        Nothing in the inbox.
      </div>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        New orders land here when integrations sync, or when you open one
        manually. Files in the cleared/closing/funded stages live in{' '}
        <Link to="/files" className="underline underline-offset-4">
          Files
        </Link>
        .
      </p>
      <Button onClick={onCreate} className="mt-5 gap-2">
        Open a manual order
      </Button>
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
        Try a different source or status, or clear the search.
      </p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onClear}>
        Reset filters
      </Button>
    </div>
  )
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}
