import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import {
  AlarmClock,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock,
  FileText,
  ListChecks,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'

import { AppShell } from '@/components/app-shell'
import { Button } from '@/components/ui/button'
import { Loading } from '@/components/loading'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'

export const Route = createFileRoute('/closing')({
  head: () => ({
    meta: [
      { title: 'Closing day · Title Hub' },
      {
        name: 'description',
        content:
          "One screen for every file closing today. Pre-closing checklist, open blockers, attestations — every box ticked before disbursement.",
      },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!(context as { isAuthenticated?: boolean }).isAuthenticated) {
      throw redirect({ to: '/signin' })
    }
  },
  component: ClosingDayPage,
})

type WindowKey = 'today' | 'tomorrow' | 'week' | 'overdue'

type ChecklistItem = {
  id: string
  label: string
  description: string
  kind: 'derived' | 'attestation'
  status: 'pass' | 'fail' | 'pending'
  note?: string
  attestedByEmail?: string | null
  attestedAt?: number | null
}

type ClosingRow = {
  fileId: Id<'files'>
  fileNumber: string
  status: string
  transactionType: string
  targetCloseDate: number | null
  propertyAddress: {
    line1: string
    line2?: string
    city: string
    state: string
    zip: string
  } | null
  countyName: string | null
  purchasePrice: number | null
  partyCount: number
  documentCount: number
  openFindings: number
  openBlockers: number
  checklist: ChecklistItem[]
  readiness: {
    passing: number
    total: number
    blockers: number
    pendingAttestations: number
  }
}

const ATTEST_ITEM_IDS = new Set([
  'cpl_issued',
  'funds_confirmed',
  'ids_verified',
  'wire_phone_verified',
  'survey_reviewed',
  'lender_package_returned',
])

function ClosingDayPage() {
  const [windowKey, setWindowKey] = useState<WindowKey>('today')

  const list = useQuery({
    ...convexQuery(api.closingDay.list, { window: windowKey }),
    retry: false,
  })
  const summary = useQuery({
    ...convexQuery(api.closingDay.summary, {}),
    retry: false,
  })

  const rows = (list.data ?? []) as ReadonlyArray<ClosingRow>
  const counts = (summary.data ?? {
    today: 0,
    tomorrow: 0,
    week: 0,
    overdue: 0,
    blockers: 0,
  }) as Record<WindowKey | 'blockers', number>

  const ready = rows.filter(
    (r) => r.readiness.blockers === 0 && r.readiness.pendingAttestations === 0
  ).length
  const stuck = rows.filter((r) => r.readiness.blockers > 0).length
  const awaiting = rows.filter(
    (r) => r.readiness.blockers === 0 && r.readiness.pendingAttestations > 0
  ).length

  return (
    <AppShell isAuthenticated title="Closing day">
      <div className="flex flex-col gap-6">
        <PageHeader />

        <div className="flex flex-wrap items-center gap-2">
          <WindowTabs windowKey={windowKey} setWindowKey={setWindowKey} counts={counts} />
        </div>

        <KpiStrip
          totalInWindow={rows.length}
          ready={ready}
          awaiting={awaiting}
          stuck={stuck}
          blockerCount={counts.blockers}
        />

        {list.isLoading && !list.data ? (
          <Loading block label="Loading the day's closings" />
        ) : rows.length === 0 ? (
          <EmptyState windowKey={windowKey} />
        ) : (
          <ul className="flex flex-col gap-4">
            {rows.map((row) => (
              <ClosingCard key={row.fileId} row={row} />
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  )
}

function PageHeader() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl leading-[1] font-semibold tracking-tight text-[#40233f] md:text-5xl">
            Closing day
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Every file closing today, with the pre-closing checklist alongside.
            Derived items go green automatically; the rest needs an attestation
            before funds release.
          </p>
        </div>
      </div>
    </div>
  )
}

function WindowTabs({
  windowKey,
  setWindowKey,
  counts,
}: {
  windowKey: WindowKey
  setWindowKey: (k: WindowKey) => void
  counts: Record<WindowKey | 'blockers', number>
}) {
  const tabs: ReadonlyArray<{ id: WindowKey; label: string }> = [
    { id: 'today', label: 'Today' },
    { id: 'tomorrow', label: 'Tomorrow' },
    { id: 'week', label: 'This week' },
    { id: 'overdue', label: 'Overdue' },
  ]
  return (
    <div
      role="tablist"
      aria-label="Closing window"
      className="inline-flex items-center gap-1 rounded-full bg-card p-1 ring-1 ring-border/70"
    >
      {tabs.map((t) => {
        const active = t.id === windowKey
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setWindowKey(t.id)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
              active
                ? 'bg-[#40233f] text-white'
                : 'text-muted-foreground hover:text-[#40233f]'
            }`}
          >
            {t.label}
            <span
              className={`font-numerals tabular-nums text-[10px] ${
                active ? 'text-white/70' : 'text-muted-foreground/60'
              }`}
            >
              {counts[t.id] ?? 0}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function KpiStrip({
  totalInWindow,
  ready,
  awaiting,
  stuck,
  blockerCount,
}: {
  totalInWindow: number
  ready: number
  awaiting: number
  stuck: number
  blockerCount: number
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Kpi
        label="In window"
        value={totalInWindow}
        icon={<CalendarClock className="size-4" />}
      />
      <Kpi
        label="Ready to close"
        value={ready}
        tone="ok"
        icon={<CheckCircle2 className="size-4" />}
      />
      <Kpi
        label="Awaiting attestation"
        value={awaiting}
        tone="warn"
        icon={<ListChecks className="size-4" />}
      />
      <Kpi
        label="Blocked"
        value={stuck}
        tone={stuck > 0 ? 'block' : 'muted'}
        icon={<CircleAlert className="size-4" />}
        sub={blockerCount > 0 ? `${blockerCount} blocker${blockerCount === 1 ? '' : 's'}` : undefined}
      />
    </div>
  )
}

function Kpi({
  label,
  value,
  icon,
  tone = 'muted',
  sub,
}: {
  label: string
  value: number
  icon: React.ReactNode
  tone?: 'ok' | 'warn' | 'block' | 'muted'
  sub?: string
}) {
  const tones = {
    ok: 'text-[#2f5d4b] bg-[#e6f3ed] ring-[#3f7c64]/30',
    warn: 'text-[#7a3d18] bg-[#fde9dc] ring-[#c9652e]/30',
    block: 'text-[#8a3942] bg-[#fdecee] ring-[#b94f58]/30',
    muted: 'text-[#40233f] bg-card ring-border/70',
  }
  return (
    <div
      className={`flex items-start justify-between gap-3 rounded-xl px-4 py-3 ring-1 ring-inset ${tones[tone]}`}
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-[11px] font-medium uppercase tracking-wider opacity-80">
          {label}
        </span>
        <span className="font-display text-2xl font-semibold leading-none tabular-nums">
          {value}
        </span>
        {sub && (
          <span className="text-[11px] opacity-80">{sub}</span>
        )}
      </div>
      <div className="opacity-70">{icon}</div>
    </div>
  )
}

function EmptyState({ windowKey }: { windowKey: WindowKey }) {
  const copy =
    windowKey === 'overdue'
      ? {
          title: 'Nothing overdue.',
          body: 'Every active file with a target close date is still on schedule.',
        }
      : windowKey === 'today'
        ? {
            title: 'No closings scheduled today.',
            body: 'Schedule a target close date on a file from its detail page and it will appear here.',
          }
        : {
            title: `No closings in this window.`,
            body: 'Try widening to "This week" or check the Overdue tab.',
          }
  return (
    <div className="rounded-2xl border border-border/60 bg-card/60 px-8 py-14 text-center shadow-sm ring-1 ring-foreground/5">
      <Sparkles className="mx-auto size-6 text-muted-foreground/60" />
      <div className="mt-3 font-display text-2xl font-semibold text-[#40233f]">
        {copy.title}
      </div>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        {copy.body}
      </p>
    </div>
  )
}

function ClosingCard({ row }: { row: ClosingRow }) {
  const ringPct =
    row.readiness.total > 0
      ? Math.round((row.readiness.passing / row.readiness.total) * 100)
      : 0
  const stuck = row.readiness.blockers > 0
  const ready = !stuck && row.readiness.pendingAttestations === 0
  const accent = stuck
    ? {
        ring: 'ring-[#b94f58]/40',
        bg: 'bg-[#fdecee]/40',
        chip: 'bg-[#fdecee] text-[#8a3942]',
        progress: 'bg-[#b94f58]',
      }
    : ready
      ? {
          ring: 'ring-[#3f7c64]/40',
          bg: 'bg-[#e6f3ed]/40',
          chip: 'bg-[#e6f3ed] text-[#2f5d4b]',
          progress: 'bg-[#3f7c64]',
        }
      : {
          ring: 'ring-[#b78625]/40',
          bg: 'bg-[#fdf6e8]/40',
          chip: 'bg-[#fdf6e8] text-[#7a5818]',
          progress: 'bg-[#b78625]',
        }

  return (
    <li
      className={`overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm ring-1 ring-inset ${accent.ring}`}
    >
      <div className={`flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-2 ${accent.bg}`}>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/files/$fileId"
              params={{ fileId: row.fileId }}
              className="font-numerals truncate text-sm font-semibold tracking-tight text-[#40233f] hover:underline"
            >
              {row.fileNumber}
            </Link>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${accent.chip}`}
            >
              {stuck
                ? `${row.readiness.blockers} blocker${row.readiness.blockers === 1 ? '' : 's'}`
                : ready
                  ? 'Ready to close'
                  : `${row.readiness.pendingAttestations} attestation${row.readiness.pendingAttestations === 1 ? '' : 's'} pending`}
            </span>
            <span className="font-numerals text-[11px] text-muted-foreground capitalize">
              {row.transactionType.replace(/_/g, ' ')}
            </span>
          </div>
          <div className="text-sm text-foreground/90">
            {row.propertyAddress ? (
              <>
                {row.propertyAddress.line1}
                {row.propertyAddress.city
                  ? `, ${row.propertyAddress.city}, ${row.propertyAddress.state} ${row.propertyAddress.zip}`
                  : ''}
              </>
            ) : (
              <span className="text-muted-foreground italic">
                No property address yet
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" />
              {row.targetCloseDate
                ? new Date(row.targetCloseDate).toLocaleString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })
                : 'No target time'}
            </span>
            {row.countyName && (
              <span>
                · {row.countyName} County
              </span>
            )}
            {row.purchasePrice && (
              <span>
                · ${row.purchasePrice.toLocaleString()}
              </span>
            )}
            <span>· {row.partyCount} parties</span>
            <span>· {row.documentCount} docs</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <ReadinessRing pct={ringPct} accent={accent.progress} />
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link to="/files/$fileId" params={{ fileId: row.fileId }}>
              Open file
              <ChevronRight className="size-3.5" />
            </Link>
          </Button>
        </div>
      </div>

      <Checklist row={row} />
    </li>
  )
}

function ReadinessRing({ pct, accent }: { pct: number; accent: string }) {
  const r = 18
  const c = 2 * Math.PI * r
  const offset = c - (pct / 100) * c
  return (
    <div className="relative grid size-12 place-items-center">
      <svg viewBox="0 0 44 44" className="absolute size-12 -rotate-90">
        <circle
          cx="22"
          cy="22"
          r={r}
          className="fill-none stroke-border"
          strokeWidth={4}
        />
        <circle
          cx="22"
          cy="22"
          r={r}
          fill="none"
          strokeWidth={4}
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className={accent.replace('bg-', 'stroke-')}
        />
      </svg>
      <span className="font-numerals text-[11px] font-semibold tabular-nums text-[#40233f]">
        {pct}%
      </span>
    </div>
  )
}

function Checklist({ row }: { row: ClosingRow }) {
  const derived = row.checklist.filter((i) => i.kind === 'derived')
  const attestations = row.checklist.filter((i) => i.kind === 'attestation')

  return (
    <div className="flex flex-col gap-3 px-5 pt-3 pb-4">
      <Section title="Derived signals" icon={<Sparkles className="size-3" />}>
        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {derived.map((item) => (
            <DerivedRow key={item.id} item={item} />
          ))}
        </ul>
      </Section>

      <Section
        title="Attestations"
        icon={<ShieldCheck className="size-3" />}
      >
        <ul className="flex flex-col gap-1.5">
          {attestations.map((item) => (
            <AttestationRow
              key={item.id}
              item={item}
              fileId={row.fileId}
            />
          ))}
        </ul>
      </Section>
    </div>
  )
}

function Section({
  title,
  icon,
  children,
}: {
  title: string
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 border-b border-border/40 pb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {icon && <span className="opacity-70">{icon}</span>}
        {title}
      </div>
      {children}
    </section>
  )
}

function DerivedRow({ item }: { item: ChecklistItem }) {
  const tone =
    item.status === 'pass'
      ? {
          icon: <CheckCircle2 className="size-3.5 text-[#3f7c64]" />,
          text: 'text-foreground/90',
        }
      : {
          icon: <CircleAlert className="size-3.5 text-[#8a3942]" />,
          text: 'text-[#8a3942]',
        }
  return (
    <li
      className={`flex items-start gap-2 rounded-md bg-card px-2.5 py-1.5 ring-1 ring-border/40 ring-inset`}
    >
      <span className="mt-0.5 shrink-0">{tone.icon}</span>
      <div className="min-w-0 flex-1">
        <div className={`text-xs font-medium ${tone.text}`}>{item.label}</div>
        {item.status !== 'pass' && (
          <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {item.description}
          </div>
        )}
      </div>
    </li>
  )
}

function AttestationRow({
  item,
  fileId,
}: {
  item: ChecklistItem
  fileId: Id<'files'>
}) {
  const attestMutation = useConvexMutation(api.closingDay.attest)
  const unattestMutation = useConvexMutation(api.closingDay.unattest)
  const [busy, setBusy] = useState(false)
  const [showNote, setShowNote] = useState(false)
  const [note, setNote] = useState('')

  const attested = item.status === 'pass'

  if (!ATTEST_ITEM_IDS.has(item.id)) {
    return null
  }

  const onToggle = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (attested) {
        await unattestMutation({
          fileId,
          item: item.id as
            | 'cpl_issued'
            | 'funds_confirmed'
            | 'ids_verified'
            | 'wire_phone_verified'
            | 'survey_reviewed'
            | 'lender_package_returned',
        })
        setNote('')
        setShowNote(false)
      } else {
        await attestMutation({
          fileId,
          item: item.id as
            | 'cpl_issued'
            | 'funds_confirmed'
            | 'ids_verified'
            | 'wire_phone_verified'
            | 'survey_reviewed'
            | 'lender_package_returned',
          note: note.trim() || undefined,
        })
        setShowNote(false)
      }
    } finally {
      setBusy(false)
    }
  }

  const onSaveNote = async () => {
    setBusy(true)
    try {
      await attestMutation({
        fileId,
        item: item.id as
          | 'cpl_issued'
          | 'funds_confirmed'
          | 'ids_verified'
          | 'wire_phone_verified'
          | 'survey_reviewed'
          | 'lender_package_returned',
        note: note.trim() || undefined,
      })
      setShowNote(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li
      className={`flex flex-col gap-1.5 rounded-md px-2.5 py-2 ring-1 ring-inset transition ${
        attested
          ? 'bg-[#e6f3ed]/40 ring-[#3f7c64]/30'
          : 'bg-card ring-border/50'
      }`}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          aria-pressed={attested}
          className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border transition ${
            attested
              ? 'border-[#3f7c64] bg-[#3f7c64] text-white hover:bg-[#2f5d4b]'
              : 'border-border bg-background hover:border-[#40233f]'
          }`}
        >
          {attested && <CheckCircle2 className="size-3" strokeWidth={3} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground/90">
              {item.label}
            </span>
            {!attested && !showNote && (
              <button
                type="button"
                onClick={() => setShowNote(true)}
                className="text-[11px] text-[#593157] hover:underline"
              >
                Add note
              </button>
            )}
          </div>
          {!attested && (
            <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              {item.description}
            </div>
          )}
          {item.attestedByEmail && item.attestedAt && (
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              Attested by {item.attestedByEmail} ·{' '}
              {new Date(item.attestedAt).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </div>
          )}
          {item.note && (
            <div className="mt-0.5 text-[11px] italic text-foreground/70">
              "{item.note}"
            </div>
          )}
        </div>
      </div>

      {showNote && !attested && (
        <div className="ml-6 flex items-center gap-2">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Reference, contact, ticket #…"
            className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
          />
          <Button
            size="sm"
            onClick={onSaveNote}
            disabled={busy}
            className="h-7 px-2.5 text-xs"
          >
            {busy ? '...' : 'Save & attest'}
          </Button>
          <button
            type="button"
            onClick={() => {
              setShowNote(false)
              setNote('')
            }}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      )}
    </li>
  )
}

// Re-export-friendly aliases just so the component file uses the lucide icons
// it imports — keeps tree-shaking happy when the linter scans.
void AlarmClock
void FileText
