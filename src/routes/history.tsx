import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { usePaginatedQuery } from 'convex/react'
import { useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'

import { AppShell } from '@/components/app-shell'
import { Button } from '@/components/ui/button'
import { SectionSkeleton } from '@/components/skeletons'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'

export const Route = createFileRoute('/history')({
  head: () => ({
    meta: [
      { title: 'History · Title Hub' },
      {
        name: 'description',
        content:
          'Full audit trail of every action taken on every file — extractions, reconciliations, attestations, mail triage, comments. Filterable by category.',
      },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!(context as { isAuthenticated?: boolean }).isAuthenticated) {
      throw redirect({ to: '/signin' })
    }
  },
  component: HistoryPage,
})

type Actor =
  | {
      kind: 'member'
      memberId: Id<'tenantMembers'>
      email: string
      name: string | null
      role: string
    }
  | { kind: 'system' }
  | { kind: 'unknown'; type: string }

type HistoryRow = {
  _id: Id<'auditEvents'>
  action: string
  occurredAt: number
  resourceType: string
  resourceId: string
  metadata?: unknown
  actor?: Actor
  file?: {
    fileId: Id<'files'>
    fileNumber: string
    propertyAddressLine1: string | null
    city: string | null
    state: string | null
  } | null
}

const FILTER_TABS: ReadonlyArray<{
  id: string
  label: string
  prefix: string | undefined
}> = [
  { id: 'all', label: 'Everything', prefix: undefined },
  { id: 'file', label: 'Files', prefix: 'file.' },
  { id: 'doc', label: 'Documents', prefix: 'document' },
  { id: 'extraction', label: 'Extractions', prefix: 'extraction.' },
  { id: 'reconciliation', label: 'Reconciliation', prefix: 'reconciliation.' },
  { id: 'finding', label: 'Findings', prefix: 'finding.' },
  { id: 'email', label: 'Mail', prefix: 'email.' },
  { id: 'closing', label: 'Closing', prefix: 'closing.' },
  { id: 'comment', label: 'Notes', prefix: 'comment.' },
  { id: 'followup', label: 'Follow-ups', prefix: 'followup.' },
  { id: 'chain', label: 'Chain summaries', prefix: 'chain_summary.' },
]

const PAGE_SIZE = 30

function HistoryPage() {
  const [filter, setFilter] = useState<string>('all')
  const tab = FILTER_TABS.find((t) => t.id === filter) ?? FILTER_TABS[0]
  const args = tab.prefix ? { actionPrefix: tab.prefix } : {}

  // usePaginatedQuery handles cursor threading + appending pages.
  const { results, status, loadMore } = usePaginatedQuery(
    api.audit.paginateForTenant,
    args,
    { initialNumItems: PAGE_SIZE },
  )
  const rows = results as ReadonlyArray<HistoryRow>

  return (
    <AppShell isAuthenticated title="History">
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="font-display text-4xl leading-[1] font-semibold tracking-tight text-[#40233f] md:text-5xl">
            History
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Every action on every file in this organization. Filter by
            category to scope the trail; click any row to jump to its file.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1 rounded-full bg-card p-1 ring-1 ring-border/70">
          {FILTER_TABS.map((t) => {
            const active = t.id === filter
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setFilter(t.id)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  active
                    ? 'bg-[#40233f] text-white'
                    : 'text-muted-foreground hover:text-[#40233f]'
                }`}
              >
                {t.label}
              </button>
            )
          })}
        </div>

        {status === 'LoadingFirstPage' ? (
          <SectionSkeleton rows={8} withHeader={false} />
        ) : rows.length === 0 ? (
          <div className="rounded-2xl border border-border/60 bg-card/60 px-8 py-14 text-center shadow-sm ring-1 ring-foreground/5">
            <Sparkles className="mx-auto size-6 text-muted-foreground/60" />
            <div className="mt-3 font-display text-2xl font-semibold text-[#40233f]">
              Nothing in this slice.
            </div>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              No audit events match the {tab.label.toLowerCase()} filter.
            </p>
          </div>
        ) : (
          <article className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/5">
            <ol className="divide-y divide-border/50">
              {rows.map((row) => (
                <HistoryRowView key={row._id} row={row} />
              ))}
            </ol>
            <div className="border-t border-border/50 px-6 py-3 text-center">
              {status === 'CanLoadMore' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => loadMore(PAGE_SIZE)}
                  className="gap-1.5"
                >
                  Load more
                </Button>
              ) : status === 'LoadingMore' ? (
                <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Loading more…
                </span>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  End of trail.
                </span>
              )}
            </div>
          </article>
        )}
      </div>
    </AppShell>
  )
}

function HistoryRowView({ row }: { row: HistoryRow }) {
  const verb = describeAction(row.action)
  const detail = actionDetail(row)
  const actor = row.actor
  const actorLabel =
    actor?.kind === 'member'
      ? actor.name && actor.name.trim().length > 0
        ? actor.name
        : actor.email
      : actor?.kind === 'system'
        ? 'System'
        : 'Unknown'

  const fileTarget = row.file
    ? { fileId: row.file.fileId, fileNumber: row.file.fileNumber }
    : row.resourceType === 'file'
      ? {
          fileId: row.resourceId as Id<'files'>,
          fileNumber: null as string | null,
        }
      : null

  const addressBlurb = row.file
    ? [row.file.propertyAddressLine1, row.file.city].filter(Boolean).join(', ')
    : null

  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    fileTarget ? (
      <Link
        to="/files/$fileId"
        params={{ fileId: fileTarget.fileId }}
        className="group/feed flex items-start gap-3 px-6 py-3 transition hover:bg-[#fdf6e8]/50"
      >
        {children}
      </Link>
    ) : (
      <div className="flex items-start gap-3 px-6 py-3">{children}</div>
    )

  return (
    <li>
      <Wrapper>
        <Avatar actor={actor} />
        <div className="min-w-0 flex-1">
          <div className="text-sm leading-snug text-[#2e2430]">
            <span className="font-medium text-[#40233f]">{actorLabel}</span>{' '}
            <span className="text-muted-foreground">{verb}</span>
            {detail && (
              <>
                {' — '}
                <span className="text-foreground/80">{detail}</span>
              </>
            )}
          </div>
          {(row.file || addressBlurb) && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs">
              {row.file?.fileNumber && (
                <span className="font-numerals font-medium text-[#40233f]">
                  {row.file.fileNumber}
                </span>
              )}
              {addressBlurb && (
                <>
                  {row.file?.fileNumber && (
                    <span className="text-muted-foreground/60">·</span>
                  )}
                  <span className="truncate text-muted-foreground">
                    {addressBlurb}
                  </span>
                </>
              )}
            </div>
          )}
          <div className="font-numerals mt-0.5 text-[11px] text-muted-foreground tabular-nums">
            {new Date(row.occurredAt).toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              second: '2-digit',
            })}
          </div>
        </div>
      </Wrapper>
    </li>
  )
}

function Avatar({ actor }: { actor?: Actor }) {
  if (actor?.kind === 'system') {
    return (
      <div className="grid size-7 shrink-0 place-items-center rounded-full bg-[#40233f] text-[#f4d48f] ring-4 ring-card">
        <Sparkles className="size-3" />
      </div>
    )
  }
  if (actor?.kind === 'member') {
    const name = (actor.name ?? '').trim()
    const initials = name
      ? name
          .split(/\s+/)
          .slice(0, 2)
          .map((p) => p[0])
          .join('')
      : (() => {
          const local = (actor.email.split('@')[0] ?? '').split(/[._-]+/)
          return (local[0]?.[0] ?? '') + (local[1]?.[0] ?? '')
        })()
    return (
      <div className="grid size-7 shrink-0 place-items-center rounded-full border border-[#40233f]/15 bg-[#fdf6e8] text-xs font-semibold text-[#40233f] ring-4 ring-card">
        {(initials || '··').toUpperCase()}
      </div>
    )
  }
  return (
    <div className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium text-muted-foreground ring-4 ring-card">
      ?
    </div>
  )
}

const VERBS: Record<string, string> = {
  'file.created': 'opened a file',
  'file.status_changed': "changed a file's status",
  'file.party_added': 'added a party',
  'file.party_removed': 'removed a party',
  'file.updated': 'updated a file',
  'file.hard_deleted': 'hard-deleted a file',
  'document.uploaded': 'uploaded a document',
  'document.deleted': 'deleted a document',
  'documents.deduped': 'removed duplicate docs',
  'extraction.requested': 'started an extraction',
  'extraction.succeeded': 'finished an extraction',
  'extraction.failed': 'extraction failed',
  'reconciliation.run': 'ran reconciliation',
  'finding.assigned': 'assigned a finding',
  'finding.status_changed': 'updated a finding',
  'finding.resolved_with': 'resolved a finding',
  'finding.verified': 'verified a finding',
  'finding.explanation_requested': 'asked the AI to explain a finding',
  'comment.created': 'left a note',
  'followup.scheduled': 'scheduled a follow-up',
  'followup.completed': 'completed a follow-up',
  'followup.cancelled': 'cancelled a follow-up',
  'closing.attested': 'attested to a closing item',
  'closing.unattested': 'undid a closing attestation',
  'email.auto_attached': 'auto-attached an email',
  'email.classifier_attached': 'classifier attached an email',
  'email.manual_attached': 'manually attached an email',
  'email.assigned': 'assigned an email',
  'email.archived': 'archived an email',
  'email.marked_spam': 'marked email as spam',
  'email.deleted': 'deleted an email',
  'email.reclassify_requested': 'asked the classifier to re-run',
  'chain_summary.requested': 'asked for a chain-of-title summary',
  'integration.created': 'created an integration',
  'secret.issued': 'issued a tokenized secret',
  'secret.revealed': 'revealed a tokenized secret',
}

function describeAction(action: string): string {
  return (
    VERBS[action] ??
    action
      .split('.')
      .pop()!
      .replace(/_/g, ' ')
      .replace(/^./, (c) => c.toLowerCase())
  )
}

function actionDetail(e: HistoryRow): string | null {
  const md = (e.metadata ?? {}) as Record<string, unknown>
  switch (e.action) {
    case 'file.status_changed':
      if (md.from && md.to) return `${md.from} → ${md.to}`
      return null
    case 'file.party_added':
    case 'file.party_removed':
      if (typeof md.legalName === 'string') return md.legalName
      return null
    case 'document.uploaded':
    case 'document.deleted':
    case 'extraction.requested':
      if (typeof md.docType === 'string') return md.docType.replace(/_/g, ' ')
      return null
    case 'reconciliation.run':
      if (md.bySeverity && typeof md.bySeverity === 'object') {
        const s = md.bySeverity as Record<string, number>
        const total = (s.block ?? 0) + (s.warn ?? 0) + (s.info ?? 0)
        if (total === 0) return 'all clear'
        const parts: string[] = []
        if (s.block)
          parts.push(`${s.block} blocker${s.block === 1 ? '' : 's'}`)
        if (s.warn) parts.push(`${s.warn} warning${s.warn === 1 ? '' : 's'}`)
        if (s.info) parts.push(`${s.info} info`)
        return parts.join(' · ')
      }
      return null
    case 'finding.verified':
      if (typeof md.method === 'string')
        return md.method.replace(/_/g, ' ')
      return null
    case 'closing.attested':
    case 'closing.unattested':
      if (typeof md.item === 'string') return md.item.replace(/_/g, ' ')
      return null
    case 'comment.created':
      if (typeof md.mentionCount === 'number' && md.mentionCount > 0) {
        return `${md.mentionCount} mention${md.mentionCount === 1 ? '' : 's'}`
      }
      return null
    case 'followup.scheduled':
      if (typeof md.dueAt === 'number') {
        return `due ${new Date(md.dueAt).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })}`
      }
      return null
    case 'email.assigned':
    case 'finding.assigned':
      if (md.to === null) return 'unassigned'
      return null
    default:
      return null
  }
}
