import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import {
  Archive,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  ExternalLink,
  FileText,
  Inbox,
  Loader2,
  Mail,
  Paperclip,
  Search,
  Shield,
  ShieldAlert,
  Sparkles,
  TimerReset,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'

import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { AppShell } from '@/components/app-shell'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/confirm-dialog'
import { Loading } from '@/components/loading'
import {
  CardListSkeleton,
  KpiStripSkeleton,
  ToolbarSkeleton,
} from '@/components/skeletons'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'

export const Route = createFileRoute('/mail')({
  head: () => ({
    meta: [
      { title: 'Mail · Title Hub' },
      {
        name: 'description',
        content:
          'Inbound email triage — auto-classified messages and attachments routed to the right file.',
      },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!(context as { isAuthenticated?: boolean }).isAuthenticated) {
      throw redirect({ to: '/signin' })
    }
  },
  loader: ({ context }) => {
    const { queryClient } = context as { queryClient: QueryClient }
    void queryClient.ensureQueryData(
      convexQuery(api.inboundEmail.list, { limit: 100 }),
    )
    void queryClient.ensureQueryData(convexQuery(api.inboundEmail.stats, {}))
    void queryClient.ensureQueryData(convexQuery(api.tenants.current, {}))
  },
  component: MailPage,
})

// ─── Types & taxonomy ─────────────────────────────────────────────────────

type StatusKey =
  | 'pending'
  | 'classifying'
  | 'auto_attached'
  | 'quarantined'
  | 'archived'
  | 'spam'
  | 'failed'

type FilterId = 'all' | StatusKey

type SpamTier = 'clean' | 'suspicious' | 'high_risk'

type Row = {
  _id: Id<'inboundEmails'>
  fromAddress: string
  fromName: string | null
  subject: string
  bodyPreview: string | null
  receivedAt: number
  status: StatusKey
  attachmentCount: number
  attachmentsPreview: ReadonlyArray<{
    _id: Id<'documents'>
    title: string | null
    docType: string
  }>
  matchConfidence: number | null
  matchReason: string | null
  matchedFile: { _id: Id<'files'>; fileNumber: string | null } | null
  classifiedAt: number | null
  errorMessage: string | null
  spamScore: number | null
  spamTier: SpamTier | null
  classification: ClassifierResult | null
}

type ClassifierResult = {
  intent: string
  confidence: number
  reasons: ReadonlyArray<string>
  suggestedFileId?: Id<'files'> | null
  suggestedFileNumber?: string | null
  classifiedAt: number
  modelId?: string | null
}

type DetailRow = {
  _id: Id<'inboundEmails'>
  fromAddress: string
  fromName: string | null
  toAddress: string
  subject: string
  bodyText: string | null
  bodyHtml: string | null
  receivedAt: number
  status: StatusKey
  matchConfidence: number | null
  matchReason: string | null
  matchedFile: {
    _id: Id<'files'>
    fileNumber: string
    propertyAddress: {
      line1: string
      line2?: string
      city: string
      state: string
      zip: string
    } | null
  } | null
  attachments: ReadonlyArray<{
    _id: Id<'documents'>
    docType: string
    title: string | null
    sizeBytes: number | null
    contentType: string | null
    fileId: Id<'files'> | null
  }>
  classifiedAt: number | null
  errorMessage: string | null
  spamScore: number | null
  spamTier: SpamTier | null
  spamSignals: ReadonlyArray<{ id: string; label: string; weight: number }>
  replyToAddress: string | null
  auth: { spf: string | null; dkim: string | null; dmarc: string | null }
  classification: ClassifierResult | null
}

const STATUS_FILTERS: ReadonlyArray<{ id: FilterId; label: string }> = [
  { id: 'all', label: 'Everything' },
  { id: 'auto_attached', label: 'Auto-attached' },
  { id: 'quarantined', label: 'Needs triage' },
  { id: 'failed', label: 'Failed' },
  { id: 'archived', label: 'Archived' },
  { id: 'spam', label: 'Spam' },
]

// Confidence above this is rendered as "auto-attached" (green). Mirrors the
// AUTO_ATTACH_CONFIDENCE constant in convex/inboundEmail.ts.
const HIGH_CONFIDENCE = 0.85

// ─── Page ─────────────────────────────────────────────────────────────────

function MailPage() {
  const current = useQuery(convexQuery(api.tenants.current, {}))
  const list = useQuery(
    convexQuery(api.inboundEmail.list, { limit: 100 })
  )
  const stats = useQuery(convexQuery(api.inboundEmail.stats, {}))
  const confirm = useConfirm()

  const archive = useConvexMutation(api.inboundEmail.archive)
  const markSpam = useConvexMutation(api.inboundEmail.markSpam)
  const removeMutation = useConvexMutation(api.inboundEmail.remove)
  const attachMutation = useConvexMutation(api.inboundEmail.attachToFile)

  const [statusFilter, setStatusFilter] = useState<FilterId>('all')
  const [q, setQ] = useState('')
  const [busyId, setBusyId] = useState<Id<'inboundEmails'> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<Id<'inboundEmails'> | null>(null)

  if (current.data === null) {
    throw redirect({ to: '/' })
  }

  if (current.error) {
    return (
      <AppShell isAuthenticated title="Mail">
        <p className="text-sm text-destructive">
          Error: {current.error.message}
        </p>
      </AppShell>
    )
  }

  const rows = (list.data ?? []) as ReadonlyArray<Row>
  const counts = (stats.data ?? {}) as Partial<Record<StatusKey, number>>

  const filtered = useMemo(() => {
    const lower = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false
      if (lower) {
        const hay = [
          r.fromAddress,
          r.fromName,
          r.subject,
          r.matchedFile?.fileNumber,
          r.matchReason,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!hay.includes(lower)) return false
      }
      return true
    })
  }, [rows, q, statusFilter])

  const onArchive = async (id: Id<'inboundEmails'>) => {
    setBusyId(id)
    setError(null)
    try {
      await archive({ inboundEmailId: id })
    } catch (err) {
      setError(stripError(err))
    } finally {
      setBusyId(null)
    }
  }

  const onMarkSpam = async (id: Id<'inboundEmails'>) => {
    const ok = await confirm({
      title: 'Mark sender as spam?',
      description:
        'Future emails from this sender will skip classification and land in the Spam tab.',
      confirmText: 'Mark as spam',
      destructive: true,
    })
    if (!ok) return
    setBusyId(id)
    setError(null)
    try {
      await markSpam({ inboundEmailId: id })
    } catch (err) {
      setError(stripError(err))
    } finally {
      setBusyId(null)
    }
  }

  const onDelete = async (id: Id<'inboundEmails'>) => {
    const ok = await confirm({
      title: 'Delete this email permanently?',
      description:
        'Attachments already routed to a file stay on the file. Unrouted attachments are removed with the email.\n\nThis cannot be undone.',
      confirmText: 'Delete',
      destructive: true,
    })
    if (!ok) return
    setBusyId(id)
    setError(null)
    try {
      await removeMutation({ inboundEmailId: id })
      if (openId === id) setOpenId(null)
    } catch (err) {
      setError(stripError(err))
    } finally {
      setBusyId(null)
    }
  }

  const onConfirmAttach = async (
    id: Id<'inboundEmails'>,
    fileId: Id<'files'>,
    opts?: { acknowledgeSpamRisk?: boolean }
  ) => {
    setBusyId(id)
    setError(null)
    try {
      await attachMutation({
        inboundEmailId: id,
        fileId,
        ...(opts?.acknowledgeSpamRisk
          ? { acknowledgeSpamRisk: true }
          : {}),
      })
      setOpenId(null)
    } catch (err) {
      setError(stripError(err))
    } finally {
      setBusyId(null)
    }
  }

  const isLoading = list.isLoading
  const isEmpty = !isLoading && rows.length === 0

  return (
    <TooltipProvider delayDuration={150}>
      <AppShell
        isAuthenticated
        title="Mail"
        subtitle={
          current.data
            ? `${current.data.legalName} · ${current.data.role}`
            : undefined
        }
      >
        <div className="flex flex-col gap-6 pb-12">
          <PageHeader />

          {!isEmpty && <KpiStrip counts={counts} onJump={setStatusFilter} />}

          {!isEmpty && (
            <Toolbar
              q={q}
              setQ={setQ}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              shown={filtered.length}
              total={rows.length}
            />
          )}

          {error && (
            <div className="rounded-md border border-[#b94f58]/30 bg-[#fdecee] px-3 py-2 text-sm text-[#8a3942]">
              {error}
            </div>
          )}

          {isLoading ? (
            <div className="flex flex-col gap-6">
              <KpiStripSkeleton />
              <ToolbarSkeleton />
              <CardListSkeleton count={6} height="h-24" />
            </div>
          ) : isEmpty ? (
            <EmptyState />
          ) : filtered.length === 0 ? (
            <NoMatches
              onClear={() => {
                setQ('')
                setStatusFilter('all')
              }}
            />
          ) : (
            <EmailList
              rows={filtered}
              busyId={busyId}
              onOpen={setOpenId}
              onArchive={onArchive}
              onMarkSpam={onMarkSpam}
              onDelete={onDelete}
              onConfirmAttach={onConfirmAttach}
            />
          )}
        </div>

        <DetailSheet
          inboundEmailId={openId}
          onClose={() => setOpenId(null)}
          busyId={busyId}
          onArchive={onArchive}
          onMarkSpam={onMarkSpam}
          onDelete={onDelete}
          onConfirmAttach={onConfirmAttach}
        />
      </AppShell>
    </TooltipProvider>
  )
}

// ─── Header ───────────────────────────────────────────────────────────────

function PageHeader() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl leading-[1] font-semibold tracking-tight text-[#40233f] md:text-5xl">
            Inbound mail
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Forward agency mail to your tenant address. We pull file numbers
            and property addresses out of the subject and body, attach PDFs to
            the right file, and run extraction. Anything we can't match
            confidently lands in <span className="font-medium">Needs triage</span>.
          </p>
        </div>
      </div>
    </div>
  )
}

// ─── KPI strip ────────────────────────────────────────────────────────────

function KpiStrip({
  counts,
  onJump,
}: {
  counts: Partial<Record<StatusKey, number>>
  onJump: (id: FilterId) => void
}) {
  const tiles: ReadonlyArray<{
    id: FilterId
    label: string
    value: number
    caption: string
    icon: React.ReactNode
    accent: string
  }> = [
    {
      id: 'auto_attached',
      label: 'Auto-attached',
      value: counts.auto_attached ?? 0,
      caption: 'Pulled in without a human',
      icon: <CheckCircle2 className="size-3.5" />,
      accent: 'text-[#2f5d4b]',
    },
    {
      id: 'quarantined',
      label: 'Needs triage',
      value: counts.quarantined ?? 0,
      caption: 'No confident match yet',
      icon: <TimerReset className="size-3.5" />,
      accent: 'text-[#7a3d18]',
    },
    {
      id: 'failed',
      label: 'Failed',
      value: counts.failed ?? 0,
      caption: 'Ingest errors to review',
      icon: <CircleAlert className="size-3.5" />,
      accent: 'text-[#8a3942]',
    },
    {
      id: 'archived',
      label: 'Archived',
      value: counts.archived ?? 0,
      caption: 'Worked through this period',
      icon: <Archive className="size-3.5" />,
      accent: 'text-[#40233f]',
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onJump(t.id)}
          aria-label={`Filter by ${t.label}`}
          className="group flex flex-col gap-1 rounded-2xl border border-border/70 bg-card px-4 py-3 text-left shadow-sm ring-1 ring-foreground/5 transition hover:border-[#593157]/40 hover:ring-[#593157]/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#593157]/40"
        >
          <div
            className={`flex items-center gap-1.5 text-xs font-medium ${t.accent}`}
          >
            {t.icon}
            {t.label}
          </div>
          <div className="font-display text-2xl leading-none font-semibold tabular-nums text-[#40233f]">
            {String(t.value).padStart(2, '0')}
          </div>
          <div className="text-xs text-muted-foreground">{t.caption}</div>
        </button>
      ))}
    </div>
  )
}

// ─── Toolbar ──────────────────────────────────────────────────────────────

function Toolbar({
  q,
  setQ,
  statusFilter,
  setStatusFilter,
  shown,
  total,
}: {
  q: string
  setQ: (s: string) => void
  statusFilter: FilterId
  setStatusFilter: (id: FilterId) => void
  shown: number
  total: number
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div
          role="tablist"
          aria-label="Filter by status"
          className="flex items-center gap-1 rounded-full bg-card p-1 ring-1 ring-border/70"
        >
          {STATUS_FILTERS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={statusFilter === s.id}
              onClick={() => setStatusFilter(s.id)}
              className={`rounded-full px-3 py-1 text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#593157]/40 ${
                statusFilter === s.id
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
            placeholder="Search sender, subject, file #..."
            className="font-numerals w-full bg-transparent text-xs text-[#2e2430] placeholder:text-muted-foreground/60 focus:outline-none"
          />
          {q && (
            <button
              type="button"
              onClick={() => setQ('')}
              className="rounded-full p-0.5 text-muted-foreground hover:text-[#40233f]"
              aria-label="Clear search"
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

// ─── List + card ──────────────────────────────────────────────────────────

function EmailList({
  rows,
  busyId,
  onOpen,
  onArchive,
  onMarkSpam,
  onDelete,
  onConfirmAttach,
}: {
  rows: ReadonlyArray<Row>
  busyId: Id<'inboundEmails'> | null
  onOpen: (id: Id<'inboundEmails'>) => void
  onArchive: (id: Id<'inboundEmails'>) => void
  onMarkSpam: (id: Id<'inboundEmails'>) => void
  onDelete: (id: Id<'inboundEmails'>) => void
  onConfirmAttach: (id: Id<'inboundEmails'>, fileId: Id<'files'>) => void
}) {
  return (
    <ol className="flex flex-col gap-3">
      {rows.map((r) => (
        <EmailCard
          key={r._id}
          row={r}
          busy={busyId === r._id}
          onOpen={() => onOpen(r._id)}
          onArchive={() => onArchive(r._id)}
          onMarkSpam={() => onMarkSpam(r._id)}
          onDelete={() => onDelete(r._id)}
          onConfirmAttach={() => {
            if (r.matchedFile) onConfirmAttach(r._id, r.matchedFile._id)
          }}
        />
      ))}
    </ol>
  )
}

function EmailCard({
  row,
  busy,
  onOpen,
  onArchive,
  onMarkSpam,
  onDelete,
  onConfirmAttach,
}: {
  row: Row
  busy: boolean
  onOpen: () => void
  onArchive: () => void
  onMarkSpam: () => void
  onDelete: () => void
  onConfirmAttach: () => void
}) {
  const isAuto = row.status === 'auto_attached'
  const isQuarantine = row.status === 'quarantined'
  const isFailed = row.status === 'failed'
  const isArchivedOrSpam = row.status === 'archived' || row.status === 'spam'
  const hasSuggestion =
    isQuarantine && row.matchedFile !== null && row.matchedFile.fileNumber

  return (
    <li className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm ring-1 ring-foreground/5 transition hover:border-[#593157]/30 hover:shadow-md">
      <button
        type="button"
        onClick={onOpen}
        className="block w-full text-left px-4 pt-3.5 pb-2 focus:outline-none focus-visible:bg-[#fdf6e8]/40"
        aria-label={`Open email: ${row.subject || '(no subject)'} from ${row.fromAddress}`}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-numerals truncate text-sm font-semibold tracking-tight text-[#40233f]">
            {row.fromName ?? row.fromAddress}
          </span>
          {row.fromName && (
            <span className="font-numerals truncate text-xs text-muted-foreground">
              · {row.fromAddress}
            </span>
          )}
          <StatusPill status={row.status} />
          <SpamBadge tier={row.spamTier} score={row.spamScore} compact />
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {formatRelative(row.receivedAt)}
          </span>
        </div>

        <div className="mt-2 flex items-start gap-2">
          <Mail className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
          <div className="min-w-0 flex-1">
            <div className="line-clamp-1 text-sm font-medium text-foreground/90">
              {row.subject || (
                <span className="text-muted-foreground italic">
                  (no subject)
                </span>
              )}
            </div>
            {row.bodyPreview && (
              <div className="mt-0.5 line-clamp-1 text-xs leading-snug text-muted-foreground">
                {row.bodyPreview}
              </div>
            )}
            {row.errorMessage && (
              <div className="mt-1 line-clamp-1 text-xs text-[#8a3942]">
                {row.errorMessage}
              </div>
            )}
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <MatchBadge row={row} />
          {row.classification && (
            <ClassificationChip
              classification={row.classification}
              compact
            />
          )}
          {row.attachmentsPreview.map((a) => (
            <AttachmentChip
              key={a._id}
              title={a.title}
              docType={a.docType}
            />
          ))}
          {row.attachmentCount > row.attachmentsPreview.length && (
            <span className="font-numerals text-[11px] text-muted-foreground/80">
              +{row.attachmentCount - row.attachmentsPreview.length} more
            </span>
          )}
          {row.matchReason &&
            !isFailed &&
            row.matchReason !== 'no_match' && (
              <span className="font-numerals text-[11px] text-muted-foreground/70">
                · {prettyReason(row.matchReason)}
              </span>
            )}
        </div>
      </button>

      <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-border/60 bg-[#fdf6e8]/40 px-3 py-2">
        {isAuto && row.matchedFile && (
          <Button
            asChild
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs"
          >
            <Link to="/files/$fileId" params={{ fileId: row.matchedFile._id }}>
              Open file
              <ChevronRight className="size-3" />
            </Link>
          </Button>
        )}

        {row.spamTier === 'high_risk' && isQuarantine ? (
          // Routing is blocked at the card level — the operator must open
          // the detail sheet, review the auth signals, and explicitly
          // override. Keeps wire-fraud out of files via the casual click.
          <Button
            variant="outline"
            size="sm"
            onClick={onOpen}
            className="h-7 gap-1.5 px-2.5 text-xs text-[#8a3942] hover:bg-[#fdecee] hover:text-[#8a3942]"
            title="High risk — review before attaching"
          >
            <ShieldAlert className="size-3" />
            Review risk
          </Button>
        ) : isQuarantine && hasSuggestion ? (
          <Button
            size="sm"
            onClick={onConfirmAttach}
            disabled={busy}
            className="h-7 gap-1.5 px-2.5 text-xs"
            title={`Confirm and attach to ${row.matchedFile?.fileNumber ?? ''}`}
          >
            {busy ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <CheckCircle2 className="size-3" />
            )}
            {busy ? 'Attaching...' : `Confirm → ${row.matchedFile?.fileNumber}`}
          </Button>
        ) : isQuarantine ? (
          <Button
            variant="default"
            size="sm"
            onClick={onOpen}
            disabled={busy}
            className="h-7 gap-1.5 px-2.5 text-xs"
          >
            <FileText className="size-3" />
            Route to file…
          </Button>
        ) : null}

        <div className="ml-auto flex items-center gap-0.5">
          <IconButton
            label="View details"
            onClick={onOpen}
            icon={<ArrowUpRight className="size-3.5" />}
          />
          {!isArchivedOrSpam && (
            <IconButton
              label="Archive"
              onClick={onArchive}
              disabled={busy}
              icon={<Archive className="size-3.5" />}
            />
          )}
          {row.status !== 'spam' && (
            <IconButton
              label="Mark as spam"
              onClick={onMarkSpam}
              disabled={busy}
              tone="danger"
              icon={<ShieldAlert className="size-3.5" />}
            />
          )}
          <IconButton
            label="Delete"
            onClick={onDelete}
            disabled={busy}
            tone="danger"
            icon={<Trash2 className="size-3.5" />}
          />
        </div>
      </div>
    </li>
  )
}

function IconButton({
  label,
  onClick,
  icon,
  disabled,
  tone,
}: {
  label: string
  onClick: () => void
  icon: React.ReactNode
  disabled?: boolean
  tone?: 'danger'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`grid size-7 place-items-center rounded-md text-muted-foreground transition hover:bg-card focus:outline-none focus-visible:ring-2 focus-visible:ring-[#593157]/40 disabled:cursor-not-allowed disabled:opacity-50 ${
        tone === 'danger'
          ? 'hover:text-[#8a3942]'
          : 'hover:text-[#40233f]'
      }`}
    >
      {icon}
    </button>
  )
}

function AttachmentChip({
  title,
  docType,
}: {
  title: string | null
  docType: string
}) {
  const display = title ?? prettyDocType(docType)
  const isPdf = (title ?? '').toLowerCase().endsWith('.pdf') || docType !== 'email'
  return (
    <span
      className="font-numerals inline-flex max-w-[18ch] items-center gap-1 rounded-full bg-card px-2 py-0.5 text-[11px] text-foreground/80 ring-1 ring-inset ring-border/70"
      title={display}
    >
      {isPdf ? (
        <FileText className="size-3 shrink-0 text-[#40233f]/70" />
      ) : (
        <Paperclip className="size-3 shrink-0 text-muted-foreground/70" />
      )}
      <span className="truncate">{display}</span>
    </span>
  )
}

// ─── Badges ───────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: StatusKey }) {
  if (status === 'auto_attached') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#e6f3ed] px-2 py-0.5 text-[11px] font-medium text-[#2f5d4b] ring-1 ring-inset ring-[#3f7c64]/30">
        <CheckCircle2 className="size-3" />
        Attached
      </span>
    )
  }
  if (status === 'quarantined') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#fdf6e8] px-2 py-0.5 text-[11px] font-medium text-[#7a5818] ring-1 ring-inset ring-[#b78625]/30">
        <TimerReset className="size-3" />
        Triage
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#fdecee] px-2 py-0.5 text-[11px] font-medium text-[#8a3942] ring-1 ring-inset ring-[#b94f58]/30">
        <CircleAlert className="size-3" />
        Failed
      </span>
    )
  }
  if (status === 'classifying') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#f2e7f1] px-2 py-0.5 text-[11px] font-medium text-[#40233f] ring-1 ring-inset ring-[#593157]/25">
        <Sparkles className="size-3 animate-pulse" />
        Classifying
      </span>
    )
  }
  if (status === 'spam') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#fdecee] px-2 py-0.5 text-[11px] font-medium text-[#8a3942] ring-1 ring-inset ring-[#b94f58]/30">
        <ShieldAlert className="size-3" />
        Spam
      </span>
    )
  }
  if (status === 'archived') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-card px-2 py-0.5 text-[11px] font-medium text-muted-foreground ring-1 ring-inset ring-border/70">
        <Archive className="size-3" />
        Archived
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-card px-2 py-0.5 text-[11px] font-medium text-muted-foreground ring-1 ring-inset ring-border/70">
      {status}
    </span>
  )
}

function MatchBadge({ row }: { row: Row }) {
  const c = row.matchConfidence
  if (row.status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#fdecee] px-2 py-0.5 text-[#8a3942] ring-1 ring-inset ring-[#b94f58]/30">
        <CircleAlert className="size-3" />
        <span>Ingest failed</span>
      </span>
    )
  }
  if (row.matchedFile && c !== null && c >= HIGH_CONFIDENCE) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-[#e6f3ed] px-2 py-0.5 text-[#2f5d4b] ring-1 ring-inset ring-[#3f7c64]/30"
        title="High-confidence match — auto-attached"
      >
        <CheckCircle2 className="size-3" />
        <span className="font-medium">
          {row.matchedFile.fileNumber ?? 'Attached'}
        </span>
        <span className="font-numerals tabular-nums opacity-80">
          · {Math.round(c * 100)}%
        </span>
      </span>
    )
  }
  if (row.matchedFile && c !== null) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-[#fde9dc] px-2 py-0.5 text-[#7a3d18] ring-1 ring-inset ring-[#b78625]/30"
        title="Low/medium confidence — needs human confirmation"
      >
        <Sparkles className="size-3" />
        <span>Suggested {row.matchedFile.fileNumber ?? '—'}</span>
        <span className="font-numerals tabular-nums opacity-80">
          · {Math.round(c * 100)}%
        </span>
      </span>
    )
  }
  if (row.status === 'classifying') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#f2e7f1] px-2 py-0.5 text-[#40233f] ring-1 ring-inset ring-[#593157]/25">
        <Loader2 className="size-3 animate-spin" />
        <span>Classifying…</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-card px-2 py-0.5 text-foreground/70 ring-1 ring-inset ring-border/70">
      <span>No match</span>
    </span>
  )
}

function SpamBadge({
  tier,
  score,
  compact,
}: {
  tier: SpamTier | null
  score: number | null
  compact?: boolean
}) {
  if (!tier) return null
  // Clean: only render in detail view (compact false). The card stays
  // calm — we surface only the not-clean tiers.
  if (tier === 'clean' && compact) return null

  const cfg =
    tier === 'high_risk'
      ? {
          bg: 'bg-[#fdecee]',
          text: 'text-[#8a3942]',
          ring: 'ring-[#b94f58]/30',
          icon: <ShieldAlert className="size-3" />,
          label: 'Likely fake',
        }
      : tier === 'suspicious'
        ? {
            bg: 'bg-[#fde9dc]',
            text: 'text-[#7a3d18]',
            ring: 'ring-[#b78625]/30',
            icon: <ShieldAlert className="size-3" />,
            label: 'Suspicious',
          }
        : {
            bg: 'bg-[#e6f3ed]',
            text: 'text-[#2f5d4b]',
            ring: 'ring-[#3f7c64]/30',
            icon: <Shield className="size-3" />,
            label: 'Authentic',
          }

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${cfg.bg} ${cfg.text} ${cfg.ring}`}
      title={
        score !== null ? `Spam score ${score}/100 — ${tier}` : undefined
      }
    >
      {cfg.icon}
      {cfg.label}
      {score !== null && (
        <span className="font-numerals tabular-nums opacity-80">
          · {score}
        </span>
      )}
    </span>
  )
}

// ─── Detail sheet ─────────────────────────────────────────────────────────

function DetailSheet({
  inboundEmailId,
  onClose,
  busyId,
  onArchive,
  onMarkSpam,
  onDelete,
  onConfirmAttach,
}: {
  inboundEmailId: Id<'inboundEmails'> | null
  onClose: () => void
  busyId: Id<'inboundEmails'> | null
  onArchive: (id: Id<'inboundEmails'>) => void
  onMarkSpam: (id: Id<'inboundEmails'>) => void
  onDelete: (id: Id<'inboundEmails'>) => void
  onConfirmAttach: (
    id: Id<'inboundEmails'>,
    fileId: Id<'files'>,
    opts?: { acknowledgeSpamRisk?: boolean }
  ) => void
}) {
  const detail = useQuery({
    ...convexQuery(
      api.inboundEmail.get,
      inboundEmailId ? { inboundEmailId } : 'skip',
    ),
    enabled: inboundEmailId !== null,
  })
  const row = detail.data as DetailRow | undefined
  const reclassifyMutation = useConvexMutation(api.inboundEmail.reclassify)
  const [riskOverridden, setRiskOverridden] = useState(false)

  // Reset the per-email override whenever the user opens a different message.
  useEffect(() => {
    setRiskOverridden(false)
  }, [inboundEmailId])

  const onReclassify = async (id: Id<'inboundEmails'>) => {
    try {
      await reclassifyMutation({ inboundEmailId: id })
    } catch {
      /* observability, not correctness */
    }
  }
  const isHighRisk = row?.spamTier === 'high_risk'
  const routingBlocked = isHighRisk && !riskOverridden
  const attach = (fileId: Id<'files'>) => {
    if (!row) return
    onConfirmAttach(
      row._id,
      fileId,
      isHighRisk ? { acknowledgeSpamRisk: true } : undefined
    )
  }

  return (
    <Sheet
      open={inboundEmailId !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-hidden bg-background data-[side=right]:sm:max-w-2xl data-[side=right]:lg:max-w-3xl"
      >
        {!row ? (
          <div className="flex flex-1 items-center justify-center py-20">
            <Loading label="Loading email" />
          </div>
        ) : (
          <>
            <SheetHeader className="shrink-0 space-y-2 border-b border-border/60 bg-card/40 px-6 py-5">
              <div className="flex items-center gap-2 pr-10 text-xs uppercase tracking-wider text-muted-foreground">
                <Mail className="size-3.5" />
                Inbound message
                <span className="ml-auto font-numerals text-[11px] text-muted-foreground tabular-nums">
                  {formatExact(row.receivedAt)}
                </span>
              </div>
              <SheetTitle className="font-display text-2xl leading-tight font-semibold text-[#40233f]">
                {row.subject || (
                  <span className="text-muted-foreground italic">
                    (no subject)
                  </span>
                )}
              </SheetTitle>
              <SheetDescription className="font-numerals flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span>
                  <span className="font-medium text-foreground/80">From:</span>{' '}
                  {row.fromName ? `${row.fromName} <${row.fromAddress}>` : row.fromAddress}
                </span>
                <span>·</span>
                <span>
                  <span className="font-medium text-foreground/80">To:</span>{' '}
                  {row.toAddress}
                </span>
              </SheetDescription>
              <div className="pt-1">
                <StatusPill status={row.status} />
              </div>
            </SheetHeader>

            <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-6">
              {/* Body and attachments sit at the top so the sheet reads like
                  an email client — message first, meta below. */}
              <BodySection bodyText={row.bodyText} bodyHtml={row.bodyHtml} />

              <SheetSection
                title="Attachments"
                icon={<Paperclip className="size-3" />}
                trailing={
                  row.attachments.length > 0
                    ? `${row.attachments.length}`
                    : undefined
                }
              >
                {row.attachments.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">
                    No attachments on this message.
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
                    {row.attachments.map((a) => (
                      <AttachmentRow key={a._id} attachment={a} />
                    ))}
                  </ul>
                )}
              </SheetSection>

              <SheetSection
                title="Authenticity"
                icon={<Shield className="size-3" />}
              >
                <DetailAuthenticity row={row} />
              </SheetSection>

              <SheetSection
                title="Match"
                icon={<FileText className="size-3" />}
              >
                <DetailMatch row={row} />
              </SheetSection>

              <SheetSection
                title="Soft classifier"
                icon={<Sparkles className="size-3" />}
              >
                <ClassifierBlock
                  classification={row.classification}
                  onReclassify={() => onReclassify(row._id)}
                />
              </SheetSection>
            </div>

            {isHighRisk && (
              <div className="shrink-0 flex flex-col gap-1.5 border-t border-[#b94f58]/30 bg-[#fdecee] px-6 py-3 text-xs text-[#8a3942]">
                <div className="flex items-center gap-1.5 font-semibold">
                  <ShieldAlert className="size-3.5" />
                  High-risk authentication failure
                </div>
                <p className="leading-snug">
                  This message failed multiple sender-authentication checks —
                  the worst-case wire-fraud pattern. Routing is blocked until
                  someone explicitly takes responsibility.
                </p>
                {!riskOverridden ? (
                  <button
                    type="button"
                    onClick={() => setRiskOverridden(true)}
                    className="self-start rounded-full bg-[#8a3942] px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-[#6c2c33]"
                  >
                    I've verified this — let me attach
                  </button>
                ) : (
                  <span className="self-start rounded-full bg-card px-3 py-1 text-[11px] font-medium text-[#8a3942] ring-1 ring-[#b94f58]/40 ring-inset">
                    Override armed — every attach is audited
                  </span>
                )}
              </div>
            )}

            <div className="shrink-0 flex items-center gap-2 border-t border-border/60 bg-background/95 px-6 py-3">
              {row.status === 'quarantined' && row.matchedFile ? (
                <Button
                  className="flex-1 gap-2"
                  onClick={() =>
                    row.matchedFile && attach(row.matchedFile._id)
                  }
                  disabled={busyId === row._id || routingBlocked}
                  title={
                    routingBlocked
                      ? 'High-risk message — override the warning above first.'
                      : undefined
                  }
                >
                  {busyId === row._id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="size-3.5" />
                  )}
                  Confirm → {row.matchedFile.fileNumber}
                </Button>
              ) : row.status === 'quarantined' ? (
                <FilePicker
                  busy={busyId === row._id}
                  blocked={routingBlocked}
                  onPick={attach}
                />
              ) : row.matchedFile ? (
                <>
                  <Button asChild variant="outline" className="flex-1 gap-2">
                    <Link
                      to="/files/$fileId"
                      params={{ fileId: row.matchedFile._id }}
                    >
                      Open file {row.matchedFile.fileNumber}
                      <ChevronRight className="size-3.5" />
                    </Link>
                  </Button>
                  <FilePicker
                    busy={busyId === row._id}
                    blocked={routingBlocked}
                    onPick={attach}
                    triggerLabel="Re-route…"
                  />
                </>
              ) : (
                // Matched file is gone (deleted) but the email is still
                // tagged as routed — fall back to the FilePicker so the
                // operator can attach it somewhere else.
                <FilePicker
                  busy={busyId === row._id}
                  blocked={routingBlocked}
                  onPick={attach}
                />
              )}

              {row.status !== 'archived' && row.status !== 'spam' && (
                <Button
                  variant="ghost"
                  onClick={() => onArchive(row._id)}
                  disabled={busyId === row._id}
                  className="gap-2 text-muted-foreground hover:text-[#40233f]"
                  aria-label="Archive email"
                >
                  <Archive className="size-3.5" />
                  Archive
                </Button>
              )}
              {row.status !== 'spam' && (
                <Button
                  variant="ghost"
                  onClick={() => onMarkSpam(row._id)}
                  disabled={busyId === row._id}
                  className="gap-2 text-muted-foreground hover:text-[#8a3942]"
                  aria-label="Mark as spam"
                >
                  <XCircle className="size-3.5" />
                  Spam
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => onDelete(row._id)}
                disabled={busyId === row._id}
                className="gap-2 text-muted-foreground hover:text-[#8a3942]"
                aria-label="Delete email"
                title="Delete this email permanently"
              >
                <Trash2 className="size-3.5" />
                Delete
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

// ─── Attachment row with inline PDF preview ──────────────────────────────
//
// Each PDF attachment can expand into an inline iframe that renders the
// signed Convex storage URL via the browser's native PDF viewer. The URL
// is fetched lazily — we only ask for it when the user opens the row.
// Non-PDFs get a Download link only.

type SheetAttachment = DetailRow['attachments'][number]

function AttachmentRow({ attachment }: { attachment: SheetAttachment }) {
  const [open, setOpen] = useState(false)
  const isPdf =
    attachment.contentType === 'application/pdf' ||
    (attachment.title ?? '').toLowerCase().endsWith('.pdf')

  const url = useQuery({
    ...convexQuery(api.files.documentUrl, { documentId: attachment._id }),
    enabled: open,
  })

  return (
    <li className="flex flex-col">
      <div className="flex items-center gap-3 px-4 py-3">
        <div
          className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
            isPdf
              ? 'bg-[#f2e7f1] text-[#40233f]'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          <FileText className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-numerals truncate text-sm text-[#40233f]">
            {attachment.title ?? 'Untitled attachment'}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span>{prettyDocType(attachment.docType)}</span>
            {attachment.sizeBytes !== null && (
              <>
                <span>·</span>
                <span className="font-numerals tabular-nums">
                  {formatBytes(attachment.sizeBytes)}
                </span>
              </>
            )}
            {attachment.fileId && (
              <>
                <span>·</span>
                <span className="inline-flex items-center gap-1 text-[#2f5d4b]">
                  <CheckCircle2 className="size-3" /> attached
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isPdf && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen((v) => !v)}
              className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-[#40233f]"
              aria-expanded={open}
            >
              {open ? (
                <ChevronUp className="size-3" />
              ) : (
                <ChevronDown className="size-3" />
              )}
              {open ? 'Hide' : 'Preview'}
            </Button>
          )}
          {open && url.data && (
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-[#40233f]"
            >
              <a href={url.data} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-3" />
                Open
              </a>
            </Button>
          )}
        </div>
      </div>
      {open && (
        <div className="border-t border-border/60 bg-muted/30 px-2 py-2">
          {url.isLoading ? (
            <div className="flex h-72 items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="mr-2 size-3.5 animate-spin" />
              Loading preview…
            </div>
          ) : url.data ? (
            <iframe
              title={`Preview: ${attachment.title ?? 'attachment'}`}
              src={url.data}
              className="h-[36rem] w-full rounded-md bg-white ring-1 ring-border/60"
            />
          ) : (
            <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
              Preview unavailable.
            </div>
          )}
        </div>
      )}
    </li>
  )
}

// ─── Body rendering ───────────────────────────────────────────────────────
//
// Email HTML can carry tracking pixels, remote images, scripts, and
// same-origin tricks. We render it inside an iframe with `sandbox=""` (no
// scripts, no same-origin, no forms, no popups) and `srcDoc` as the only
// surface. That blocks the dangerous classes by construction without
// pulling in DOMPurify or hand-rolling a sanitizer. A Text fallback is
// always available via the toggle.

function BodySection({
  bodyText,
  bodyHtml,
}: {
  bodyText: string | null
  bodyHtml: string | null
}) {
  const hasBoth = !!bodyHtml && !!bodyText
  const initialView: 'html' | 'text' = bodyHtml ? 'html' : 'text'
  const [view, setView] = useState<'html' | 'text'>(initialView)
  const effective = view === 'html' && !bodyHtml ? 'text' : view

  if (!bodyHtml && !bodyText) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No body included. The provider may have only sent attachments.
      </p>
    )
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-2">
        {hasBoth && (
          <div
            role="tablist"
            aria-label="Body format"
            className="self-start inline-flex items-center gap-1 rounded-full bg-card p-1 ring-1 ring-border/70"
          >
            <BodyTab
              active={effective === 'html'}
              onClick={() => setView('html')}
            >
              Rendered
            </BodyTab>
            <BodyTab
              active={effective === 'text'}
              onClick={() => setView('text')}
            >
              Plain text
            </BodyTab>
          </div>
        )}

        {effective === 'html' && bodyHtml ? (
          <SandboxedHtml html={bodyHtml} />
        ) : (
          <div className="max-h-[28rem] overflow-y-auto whitespace-pre-wrap rounded-xl bg-card/60 px-5 py-4 text-sm leading-relaxed text-foreground/90">
            {bodyText ?? (
              <span className="text-muted-foreground italic">
                No plain-text body — the sender shipped HTML only.
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function BodyTab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-[11px] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#593157]/40 ${
        active
          ? 'bg-[#40233f] text-[#f6e8d9] shadow-sm'
          : 'text-muted-foreground hover:text-[#40233f]'
      }`}
    >
      {children}
    </button>
  )
}

// Wraps the provider HTML in a minimal document scoped by a base font-size
// + max-width, then renders into a sandboxed iframe. The sandbox attribute
// is empty (`sandbox=""`) to deny ALL capabilities — including same-origin
// access, scripts, forms, popups, and top-level navigation.
function SandboxedHtml({ html }: { html: string }) {
  const srcDoc = `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <base target="_blank">
  <style>
    :root { color-scheme: light; }
    html, body {
      margin: 0;
      padding: 16px;
      background: #ffffff;
      color: #2e2430;
      font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      word-wrap: break-word;
    }
    img, video { max-width: 100%; height: auto; }
    a { color: #40233f; text-decoration: underline; text-underline-offset: 2px; }
    blockquote { border-left: 3px solid #d9d2da; margin: 0; padding-left: 10px; color: #5b5060; }
    pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    table { border-collapse: collapse; max-width: 100%; }
    table td, table th { padding: 4px 8px; }
  </style>
</head><body>${html}</body></html>`

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
      <iframe
        title="Email body"
        sandbox=""
        srcDoc={srcDoc}
        className="h-72 w-full bg-white"
        // Even if a renderer exception fires the parent stays alive thanks
        // to the empty sandbox; no need for an additional onError.
      />
    </div>
  )
}

// ─── File picker ──────────────────────────────────────────────────────────
//
// A search-as-you-type combobox over `api.search.global`. Lives inside the
// detail sheet's footer so a processor can route a quarantined email to any
// file in their tenant — not just the (low-confidence) auto-suggestion.

type FileHit = {
  _id: Id<'files'>
  fileNumber: string
  transactionType: string
  status: string
}

function FilePicker({
  busy,
  blocked = false,
  onPick,
  triggerLabel = 'Route to file…',
}: {
  busy: boolean
  /**
   * When true the trigger renders disabled with a tooltip and the popover
   * never opens — used to gate routing while a high-risk wire-fraud
   * warning is unacknowledged.
   */
  blocked?: boolean
  onPick: (fileId: Id<'files'>) => void
  triggerLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const trimmed = q.trim()

  const search = useQuery({
    ...convexQuery(api.search.global, { q: trimmed }),
    enabled: trimmed.length >= 2,
  })
  const recent = useQuery({
    ...convexQuery(api.files.list, { limit: 8 }),
    enabled: trimmed.length < 2,
  })

  // Either show search results (typing) or a recents fallback (idle).
  const hits: ReadonlyArray<FileHit> =
    trimmed.length >= 2
      ? ((search.data as { files?: ReadonlyArray<FileHit> } | undefined)?.files ?? [])
      : ((recent.data as ReadonlyArray<FileHit> | undefined) ?? []).map((f) => ({
          _id: f._id,
          fileNumber: f.fileNumber,
          transactionType: f.transactionType,
          status: f.status,
        }))

  const headline =
    trimmed.length >= 2
      ? search.isLoading
        ? 'Searching…'
        : hits.length === 0
          ? 'No files match'
          : `${hits.length} match${hits.length === 1 ? '' : 'es'}`
      : 'Recent files'

  return (
    <Popover open={blocked ? false : open} onOpenChange={(o) => !blocked && setOpen(o)}>
      <PopoverTrigger asChild>
        <Button
          variant={triggerLabel === 'Route to file…' ? 'default' : 'outline'}
          className={triggerLabel === 'Route to file…' ? 'flex-1 gap-2' : 'gap-2'}
          disabled={busy || blocked}
          aria-label={triggerLabel}
          title={
            blocked
              ? 'High-risk message — override the warning above first.'
              : undefined
          }
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <FileText className="size-3.5" />
          )}
          {triggerLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="w-[28rem] overflow-hidden border-border/70 p-0 shadow-md"
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={q}
            onValueChange={setQ}
            placeholder="Search file #, address, county..."
          />
          <CommandList>
            <div className="flex items-center justify-between px-3 py-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
              <span>{headline}</span>
              {trimmed.length < 2 && (
                <span className="text-[10px] normal-case tracking-normal text-muted-foreground/70">
                  Type 2+ chars to search
                </span>
              )}
            </div>
            {hits.length === 0 && trimmed.length >= 2 && !search.isLoading && (
              <CommandEmpty>
                Nothing matches "{trimmed}". Try a file # or property line.
              </CommandEmpty>
            )}
            <CommandGroup>
              {hits.map((f) => (
                <CommandItem
                  key={f._id}
                  value={f._id}
                  onSelect={() => {
                    setOpen(false)
                    setQ('')
                    onPick(f._id)
                  }}
                  className="flex items-center gap-3 py-2"
                >
                  <FileText className="size-3.5 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="font-numerals truncate text-sm font-medium text-[#40233f]">
                      {f.fileNumber}
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="capitalize">{f.transactionType}</span>
                      <span>·</span>
                      <span>{f.status.replace(/_/g, ' ')}</span>
                    </div>
                  </div>
                  <ChevronRight className="size-3 text-muted-foreground/60" />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function SheetSection({
  title,
  icon,
  trailing,
  children,
}: {
  title: string
  icon?: React.ReactNode
  trailing?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <header className="flex items-center justify-between gap-2 border-b border-border/40 pb-1.5">
        <h3 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          {icon && (
            <span className="text-muted-foreground/70">{icon}</span>
          )}
          {title}
        </h3>
        {trailing && (
          <span className="font-numerals text-[11px] text-muted-foreground/70 tabular-nums">
            {trailing}
          </span>
        )}
      </header>
      {children}
    </section>
  )
}

function DetailAuthenticity({ row }: { row: DetailRow }) {
  const tier = row.spamTier
  const score = row.spamScore
  if (!tier) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No authenticity check ran for this message.
      </p>
    )
  }

  const accent =
    tier === 'high_risk'
      ? { bar: 'bg-[#b94f58]', text: 'text-[#8a3942]', bg: 'bg-[#fdecee]' }
      : tier === 'suspicious'
        ? { bar: 'bg-[#b78625]', text: 'text-[#7a3d18]', bg: 'bg-[#fde9dc]' }
        : { bar: 'bg-[#3f7c64]', text: 'text-[#2f5d4b]', bg: 'bg-[#e6f3ed]' }

  const summary =
    tier === 'high_risk'
      ? "Multiple authentication / heuristic signals failed. Treat the sender as unverified — don't release funds, attach to a file, or click links until you've confirmed by phone using a number from a prior unrelated document."
      : tier === 'suspicious'
        ? 'Some signals are off. Review the breakdown below before acting on anything time-sensitive.'
        : 'Sender authentication checks passed. No look-alike, spoofing, or BEC patterns detected.'

  const positive = row.spamSignals.filter((s) => s.weight > 0)
  const negative = row.spamSignals.filter((s) => s.weight < 0)

  return (
    <div className={`flex flex-col gap-3 rounded-xl ${accent.bg} p-4`}>
      <div className="flex items-start gap-3">
        <div className="flex flex-col items-center gap-1">
          <div className={`font-display text-3xl leading-none font-semibold tabular-nums ${accent.text}`}>
            {score ?? 0}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            of 100
          </div>
        </div>
        <div className="flex-1">
          <div className={`text-xs font-semibold uppercase tracking-wider ${accent.text}`}>
            {tier === 'high_risk'
              ? 'High risk'
              : tier === 'suspicious'
                ? 'Suspicious'
                : 'Authentic'}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-foreground/80">
            {summary}
          </p>
        </div>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-card/60">
        <div
          className={`h-full ${accent.bar} transition-all`}
          style={{ width: `${score ?? 0}%` }}
        />
      </div>

      <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
        <AuthChip name="SPF" verdict={row.auth.spf} />
        <AuthChip name="DKIM" verdict={row.auth.dkim} />
        <AuthChip name="DMARC" verdict={row.auth.dmarc} />
        {row.replyToAddress && (
          <span className="font-numerals inline-flex items-center gap-1 rounded-full bg-card px-2 py-0.5 ring-1 ring-inset ring-border/70">
            <span className="text-muted-foreground">Reply-To:</span>
            {row.replyToAddress}
          </span>
        )}
      </div>

      {positive.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            What fired
          </div>
          <ul className="flex flex-col gap-1">
            {positive.map((s) => (
              <li
                key={s.id}
                className="flex items-start gap-2 rounded-md bg-card/70 px-2.5 py-1.5 text-xs text-foreground/85 ring-1 ring-border/60"
              >
                <span
                  aria-hidden
                  className={`mt-1.5 inline-flex size-1.5 shrink-0 rounded-full ${accent.bar}`}
                />
                <span className="flex-1">{s.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {negative.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Trust signals
          </div>
          <ul className="flex flex-col gap-1">
            {negative.map((s) => (
              <li
                key={s.id}
                className="flex items-start gap-2 rounded-md bg-card/70 px-2.5 py-1.5 text-xs text-foreground/85 ring-1 ring-border/60"
              >
                <span
                  aria-hidden
                  className="mt-1.5 inline-flex size-1.5 shrink-0 rounded-full bg-[#3f7c64]"
                />
                <span className="flex-1">{s.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function AuthChip({
  name,
  verdict,
}: {
  name: string
  verdict: string | null
}) {
  const v = verdict?.toLowerCase()
  const tone =
    v === 'pass'
      ? 'bg-[#e6f3ed] text-[#2f5d4b] ring-[#3f7c64]/30'
      : v === 'fail' || v === 'permerror'
        ? 'bg-[#fdecee] text-[#8a3942] ring-[#b94f58]/30'
        : 'bg-card text-muted-foreground ring-border/70'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ring-1 ring-inset ${tone}`}
      title={`${name}: ${verdict ?? 'no verdict'}`}
    >
      <span className="font-medium">{name}</span>
      <span className="opacity-80">{verdict ?? '—'}</span>
    </span>
  )
}

function DetailMatch({ row }: { row: DetailRow }) {
  if (row.matchedFile) {
    const c = row.matchConfidence
    const isHigh = c !== null && c >= HIGH_CONFIDENCE
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4">
        <div className="flex items-start gap-3">
          <div
            className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
              isHigh
                ? 'bg-[#e6f3ed] text-[#2f5d4b]'
                : 'bg-[#fde9dc] text-[#7a3d18]'
            }`}
          >
            {isHigh ? (
              <CheckCircle2 className="size-4" />
            ) : (
              <Sparkles className="size-4" />
            )}
          </div>
          <div className="min-w-0">
            <div className="font-numerals text-sm font-semibold text-[#40233f]">
              {row.matchedFile.fileNumber}
            </div>
            {row.matchedFile.propertyAddress && (
              <div className="text-xs text-muted-foreground">
                {row.matchedFile.propertyAddress.line1}
                {row.matchedFile.propertyAddress.city
                  ? ` · ${row.matchedFile.propertyAddress.city}, ${row.matchedFile.propertyAddress.state} ${row.matchedFile.propertyAddress.zip}`
                  : ''}
              </div>
            )}
          </div>
          <span
            className={`font-numerals ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ring-1 ring-inset ${
              isHigh
                ? 'bg-[#e6f3ed] text-[#2f5d4b] ring-[#3f7c64]/30'
                : 'bg-[#fde9dc] text-[#7a3d18] ring-[#b78625]/30'
            }`}
          >
            {c !== null ? `${Math.round(c * 100)}%` : '—'}
          </span>
        </div>
        {row.matchReason && (
          <div className="text-[11px] italic text-muted-foreground">
            {prettyReason(row.matchReason)}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="rounded-xl border border-dashed border-border/60 bg-card/60 p-4 text-sm text-muted-foreground">
      No file matched the subject, body, or address. Use the picker below to
      route this manually.
    </div>
  )
}

// ─── Classifier surfaces ──────────────────────────────────────────────────

const INTENT_LABELS: Record<string, string> = {
  wire_instructions: 'Wire instructions',
  payoff: 'Payoff statement',
  title_commitment: 'Title commitment',
  closing_disclosure: 'Closing disclosure',
  county_response: 'County response',
  buyer_info: 'Buyer info',
  lender_correspondence: 'Lender correspondence',
  title_document: 'Title document',
  marketing: 'Marketing',
  phishing: 'Phishing',
  other: 'Other',
}

function intentTone(intent: string): {
  bg: string
  text: string
  ring: string
} {
  switch (intent) {
    case 'wire_instructions':
      return {
        bg: 'bg-[#fde9dc]',
        text: 'text-[#7a3d18]',
        ring: 'ring-[#c9652e]/30',
      }
    case 'phishing':
      return {
        bg: 'bg-[#fdecee]',
        text: 'text-[#8a3942]',
        ring: 'ring-[#b94f58]/30',
      }
    case 'marketing':
      return {
        bg: 'bg-muted',
        text: 'text-muted-foreground',
        ring: 'ring-border/70',
      }
    case 'closing_disclosure':
    case 'title_commitment':
    case 'title_document':
      return {
        bg: 'bg-[#e8f0f8]',
        text: 'text-[#2c4a6b]',
        ring: 'ring-[#3f668f]/30',
      }
    case 'county_response':
    case 'payoff':
    case 'lender_correspondence':
    case 'buyer_info':
      return {
        bg: 'bg-[#fdf6e8]',
        text: 'text-[#7a5818]',
        ring: 'ring-[#b78625]/30',
      }
    default:
      return {
        bg: 'bg-card',
        text: 'text-muted-foreground',
        ring: 'ring-border/70',
      }
  }
}

function ClassificationChip({
  classification,
  compact,
}: {
  classification: ClassifierResult
  compact?: boolean
}) {
  const tone = intentTone(classification.intent)
  const label =
    INTENT_LABELS[classification.intent] ?? classification.intent
  const pct = Math.round(classification.confidence * 100)
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tone.bg} ${tone.text} ${tone.ring}`}
      title={
        classification.reasons.length > 0
          ? `Reasons: ${classification.reasons.join('; ')}`
          : undefined
      }
    >
      <Sparkles className="size-3" />
      {label}
      {!compact && (
        <span className="font-numerals tabular-nums opacity-80">· {pct}%</span>
      )}
    </span>
  )
}

function ClassifierBlock({
  classification,
  onReclassify,
}: {
  classification: ClassifierResult | null
  onReclassify?: () => void
}) {
  if (!classification) {
    return (
      <div className="rounded-xl border border-dashed border-border/60 bg-card/60 px-4 py-3 text-xs text-muted-foreground">
        Soft classifier hasn't run yet — once it does, you'll see the model's
        intent and reasoning here.
        {onReclassify && (
          <button
            type="button"
            onClick={onReclassify}
            className="ml-2 text-[#593157] underline-offset-4 hover:underline"
          >
            Run now
          </button>
        )}
      </div>
    )
  }
  const tone = intentTone(classification.intent)
  const pct = Math.round(classification.confidence * 100)
  const label =
    INTENT_LABELS[classification.intent] ?? classification.intent
  return (
    <div
      className={`rounded-xl border border-border/60 bg-card p-4 ring-1 ring-inset ${tone.ring}`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${tone.bg} ${tone.text}`}
        >
          <Sparkles className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span
              className={`font-numerals text-sm font-semibold ${tone.text}`}
            >
              {label}
            </span>
            <span
              className={`font-numerals inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ring-1 ring-inset ${tone.bg} ${tone.text} ${tone.ring}`}
            >
              {pct}%
            </span>
          </div>
          {classification.reasons.length > 0 && (
            <ul className="mt-1.5 flex flex-col gap-1 text-xs text-muted-foreground">
              {classification.reasons.map((r, i) => (
                <li
                  key={`${i}-${r.slice(0, 12)}`}
                  className="flex items-start gap-1.5 leading-snug"
                >
                  <span className="mt-1 inline-block size-1 shrink-0 rounded-full bg-current opacity-60" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          )}
          {classification.suggestedFileNumber && (
            <div className="mt-2 text-[11px] text-muted-foreground">
              Suggested file:{' '}
              <span className="font-numerals font-medium text-[#40233f]">
                {classification.suggestedFileNumber}
              </span>
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground/80">
            <span className="whitespace-nowrap">
              Classified {formatRelative(classification.classifiedAt)}
            </span>
            {onReclassify && (
              <>
                <span aria-hidden>·</span>
                <button
                  type="button"
                  onClick={onReclassify}
                  className="whitespace-nowrap text-[#593157] underline-offset-4 hover:underline"
                >
                  Re-run
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Empty / no-matches ───────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="rounded-2xl border border-border/60 bg-card/60 px-8 py-14 text-center shadow-sm ring-1 ring-foreground/5">
      <Inbox className="mx-auto size-6 text-muted-foreground/60" />
      <div className="mt-3 font-display text-2xl font-semibold text-[#40233f]">
        Nothing in the inbox.
      </div>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Forward agency mail to your tenant address (set up under{' '}
        <Link to="/admin" className="underline underline-offset-4">
          Admin
        </Link>
        ). Once a message arrives we'll classify it and try to attach
        documents to the right file automatically.
      </p>
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
        Try a different status, or clear the search.
      </p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onClear}>
        Reset filters
      </Button>
    </div>
  )
}

// ─── Formatters ───────────────────────────────────────────────────────────

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

function formatExact(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function prettyDocType(t: string): string {
  return t
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// "filenumber_in_subject:25-001234" -> "File # in subject (25-001234)"
function prettyReason(r: string): string {
  if (r === 'no_match') return 'No file match'
  if (r === 'manual_attach') return 'Confirmed manually'
  if (r === 'manual_attach_high_risk_override')
    return 'Manually attached (high-risk override)'
  const fileGone = r.match(/^(.*?);\s*file_deleted$/)
  if (fileGone) return `${prettyReason(fileGone[1])} — file removed`
  const blocked = r.match(/^(.*?);\s*blocked_by_status:(.+)$/)
  if (blocked) {
    return `${prettyReason(blocked[1])} — file is ${blocked[2].replace(/_/g, ' ')}`
  }
  const escalation = r.match(/^classifier_escalation:(.+)$/)
  if (escalation) {
    return `Routed by classifier (${escalation[1].replace(/_/g, ' ')})`
  }
  const m = r.match(/^filenumber_in_(subject|body):(.+)$/)
  if (m) return `File # in ${m[1]} (${m[2]})`
  const a = r.match(/^address_overlap:(.+)$/)
  if (a) return `Address overlap (${a[1]})`
  return r
}

function stripError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^.*ConvexError:\s*/, '')
}
