import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import {
  AlarmClock,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Inbox,
  Mail,
  Sparkles,
  UserPlus,
} from 'lucide-react'

import { AppShell } from '@/components/app-shell'
import { Button } from '@/components/ui/button'
import { SectionSkeleton } from '@/components/skeletons'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'

export const Route = createFileRoute('/queue')({
  head: () => ({
    meta: [
      { title: 'My queue · Title Hub' },
      {
        name: 'description',
        content:
          "Everything that needs your attention — overdue follow-ups, assigned findings, mail triage, and team work that needs an owner.",
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
    void queryClient.ensureQueryData(convexQuery(api.myQueue.list, {}))
  },
  component: MyQueuePage,
})

type FollowupItem = {
  _id: string
  fileId: Id<'files'>
  fileNumber: string | null
  note: string
  dueAt: number
}

type FindingItem = {
  _id: Id<'reconciliationFindings'>
  fileId: Id<'files'>
  fileNumber: string | null
  severity: 'info' | 'warn' | 'block'
  findingType: string
  message: string
  status: 'open' | 'acknowledged'
}

type EmailItem = {
  _id: Id<'inboundEmails'>
  subject: string
  fromAddress: string
  receivedAt: number
  status: string
  classificationIntent: string | null
  matchedFileId: Id<'files'> | null
}

type UnownedBlocker = {
  _id: Id<'reconciliationFindings'>
  fileId: Id<'files'>
  fileNumber: string | null
  findingType: string
  message: string
  createdAt: number
}

type UnownedTriage = {
  _id: Id<'inboundEmails'>
  subject: string
  fromAddress: string
  receivedAt: number
  classificationIntent: string | null
  spamTier: string | null
}

type QueueData = {
  overdueFollowups: ReadonlyArray<FollowupItem>
  myFindings: ReadonlyArray<FindingItem>
  myEmails: ReadonlyArray<EmailItem>
  upcomingFollowups: ReadonlyArray<FollowupItem>
  unownedBlockers: ReadonlyArray<UnownedBlocker>
  unownedTriage: ReadonlyArray<UnownedTriage>
}

function MyQueuePage() {
  const data = useQuery({
    ...convexQuery(api.myQueue.list, {}),
    retry: false,
  })
  const queue = (data.data ?? {
    overdueFollowups: [],
    myFindings: [],
    myEmails: [],
    upcomingFollowups: [],
    unownedBlockers: [],
    unownedTriage: [],
  }) as QueueData

  const totalMine =
    queue.overdueFollowups.length +
    queue.myFindings.length +
    queue.myEmails.length +
    queue.upcomingFollowups.length

  return (
    <AppShell isAuthenticated title="My queue">
      <div className="flex flex-col gap-6">
        <PageHeader totalMine={totalMine} />

        {data.isLoading && !data.data ? (
          <div className="flex flex-col gap-6">
            <SectionSkeleton rows={3} />
            <SectionSkeleton rows={2} />
          </div>
        ) : totalMine === 0 &&
          queue.unownedBlockers.length === 0 &&
          queue.unownedTriage.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-6">
            {queue.overdueFollowups.length > 0 && (
              <Section
                title="Overdue follow-ups"
                icon={<AlarmClock className="size-4" />}
                tone="block"
                count={queue.overdueFollowups.length}
              >
                <FollowupList items={queue.overdueFollowups} overdue />
              </Section>
            )}

            {queue.myFindings.length > 0 && (
              <Section
                title="Your findings"
                icon={<Sparkles className="size-4" />}
                tone="warn"
                count={queue.myFindings.length}
              >
                <FindingList items={queue.myFindings} />
              </Section>
            )}

            {queue.myEmails.length > 0 && (
              <Section
                title="Your mail triage"
                icon={<Mail className="size-4" />}
                tone="warn"
                count={queue.myEmails.length}
              >
                <EmailList items={queue.myEmails} />
              </Section>
            )}

            {queue.upcomingFollowups.length > 0 && (
              <Section
                title="Coming up"
                icon={<CalendarClock className="size-4" />}
                tone="info"
                count={queue.upcomingFollowups.length}
              >
                <FollowupList items={queue.upcomingFollowups} />
              </Section>
            )}

            {(queue.unownedBlockers.length > 0 ||
              queue.unownedTriage.length > 0) && (
              <div className="rounded-2xl border border-dashed border-border/60 bg-card/40 p-4">
                <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Needs an owner
                </div>
                <p className="mt-1 mb-3 text-xs text-muted-foreground">
                  Open work that nobody on the team has picked up yet. Claim
                  any of it from its detail page.
                </p>
                {queue.unownedBlockers.length > 0 && (
                  <Section
                    title="Blockers without an owner"
                    icon={<CircleAlert className="size-4" />}
                    tone="block"
                    count={queue.unownedBlockers.length}
                  >
                    <UnownedBlockerList items={queue.unownedBlockers} />
                  </Section>
                )}
                {queue.unownedTriage.length > 0 && (
                  <div className="mt-4">
                    <Section
                      title="Quarantined mail without an owner"
                      icon={<Inbox className="size-4" />}
                      tone="warn"
                      count={queue.unownedTriage.length}
                    >
                      <UnownedTriageList items={queue.unownedTriage} />
                    </Section>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </AppShell>
  )
}

function PageHeader({ totalMine }: { totalMine: number }) {
  return (
    <div>
      <h1 className="font-display text-4xl leading-[1] font-semibold tracking-tight text-[#40233f] md:text-5xl">
        My queue
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        {totalMine === 0
          ? "Nothing assigned to you right now. Anything the team owes a decision on is below."
          : `${totalMine} ${totalMine === 1 ? 'item' : 'items'} on your plate. Overdue work first.`}
      </p>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-border/60 bg-card/60 px-8 py-14 text-center shadow-sm ring-1 ring-foreground/5">
      <CheckCircle2 className="mx-auto size-7 text-[#3f7c64]" />
      <div className="mt-3 font-display text-2xl font-semibold text-[#40233f]">
        Inbox zero.
      </div>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Nothing assigned to you, no overdue follow-ups, and the team's
        blocker queue is empty. Nice.
      </p>
    </div>
  )
}

function Section({
  title,
  icon,
  tone,
  count,
  children,
}: {
  title: string
  icon: React.ReactNode
  tone: 'block' | 'warn' | 'info'
  count: number
  children: React.ReactNode
}) {
  const accent = {
    block: 'text-[#8a3942]',
    warn: 'text-[#7a3d18]',
    info: 'text-[#2c4a6b]',
  }[tone]
  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-2 border-b border-border/40 pb-1.5">
        <h2
          className={`flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.08em] ${accent}`}
        >
          <span className="opacity-80">{icon}</span>
          {title}
        </h2>
        <span className="font-numerals text-[11px] tabular-nums text-muted-foreground">
          {count}
        </span>
      </header>
      {children}
    </section>
  )
}

function FollowupList({
  items,
  overdue,
}: {
  items: ReadonlyArray<FollowupItem>
  overdue?: boolean
}) {
  const completeMutation = useConvexMutation(api.followups.complete)
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item) => (
        <li
          key={item._id}
          className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 ring-1 ring-inset ${
            overdue
              ? 'border-[#b94f58]/30 bg-[#fdecee]/40 ring-[#b94f58]/30'
              : 'border-border/60 bg-card ring-border/40'
          }`}
        >
          <AlarmClock
            className={`mt-0.5 size-4 shrink-0 ${overdue ? 'text-[#8a3942]' : 'text-muted-foreground'}`}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <Link
                to="/files/$fileId"
                params={{ fileId: item.fileId }}
                className="font-numerals truncate text-sm font-semibold text-[#40233f] hover:underline"
              >
                {item.fileNumber ?? item.fileId}
              </Link>
              <span className="text-[11px] text-muted-foreground">
                Due {new Date(item.dueAt).toLocaleString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
            </div>
            <p className="mt-0.5 text-xs leading-snug text-foreground/85">
              {item.note}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              completeMutation({ followupId: item._id as Id<'fileFollowups'> })
            }
            className="h-7 gap-1.5 px-2.5 text-xs"
          >
            <CheckCircle2 className="size-3" />
            Done
          </Button>
        </li>
      ))}
    </ul>
  )
}

function FindingList({ items }: { items: ReadonlyArray<FindingItem> }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((f) => {
        const tone =
          f.severity === 'block'
            ? 'border-[#b94f58]/30 bg-[#fdecee]/40 ring-[#b94f58]/30'
            : f.severity === 'warn'
              ? 'border-[#c9652e]/30 bg-[#fde9dc]/40 ring-[#c9652e]/30'
              : 'border-[#3f668f]/30 bg-[#e8f0f8]/40 ring-[#3f668f]/30'
        return (
          <li
            key={f._id}
            className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 ring-1 ring-inset ${tone}`}
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-foreground/80" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <Link
                  to="/files/$fileId"
                  params={{ fileId: f.fileId }}
                  className="font-numerals truncate text-sm font-semibold text-[#40233f] hover:underline"
                >
                  {f.fileNumber ?? f.fileId}
                </Link>
                <span className="text-[11px] text-muted-foreground capitalize">
                  {f.findingType.replace(/_/g, ' ')} · {f.severity}
                  {f.status === 'acknowledged' ? ' · acknowledged' : ''}
                </span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-foreground/85">
                {f.message}
              </p>
            </div>
            <Button asChild variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-xs">
              <Link to="/files/$fileId" params={{ fileId: f.fileId }}>
                Open
                <ChevronRight className="size-3" />
              </Link>
            </Button>
          </li>
        )
      })}
    </ul>
  )
}

function EmailList({ items }: { items: ReadonlyArray<EmailItem> }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((e) => (
        <li
          key={e._id}
          className="flex items-start gap-3 rounded-xl border border-border/60 bg-card px-3 py-2.5 ring-1 ring-border/40 ring-inset"
        >
          <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="truncate text-sm font-medium text-[#40233f]">
                {e.subject || '(no subject)'}
              </span>
              {e.classificationIntent && (
                <span className="text-[11px] text-muted-foreground capitalize">
                  · {e.classificationIntent.replace(/_/g, ' ')}
                </span>
              )}
            </div>
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
              from {e.fromAddress}
            </p>
          </div>
          <Button asChild variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-xs">
            <Link to="/mail">
              Open
              <ChevronRight className="size-3" />
            </Link>
          </Button>
        </li>
      ))}
    </ul>
  )
}

function UnownedBlockerList({
  items,
}: {
  items: ReadonlyArray<UnownedBlocker>
}) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((f) => (
        <li
          key={f._id}
          className="flex items-start gap-3 rounded-xl border border-[#b94f58]/30 bg-[#fdecee]/30 px-3 py-2.5 ring-1 ring-[#b94f58]/30 ring-inset"
        >
          <UserPlus className="mt-0.5 size-4 shrink-0 text-[#8a3942]" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <Link
                to="/files/$fileId"
                params={{ fileId: f.fileId }}
                className="font-numerals truncate text-sm font-semibold text-[#40233f] hover:underline"
              >
                {f.fileNumber ?? f.fileId}
              </Link>
              <span className="text-[11px] text-muted-foreground capitalize">
                {f.findingType.replace(/_/g, ' ')}
              </span>
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-foreground/85">
              {f.message}
            </p>
          </div>
          <Button asChild variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-xs">
            <Link to="/files/$fileId" params={{ fileId: f.fileId }}>
              Claim
              <ChevronRight className="size-3" />
            </Link>
          </Button>
        </li>
      ))}
    </ul>
  )
}

function UnownedTriageList({
  items,
}: {
  items: ReadonlyArray<UnownedTriage>
}) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((e) => (
        <li
          key={e._id}
          className="flex items-start gap-3 rounded-xl border border-[#c9652e]/30 bg-[#fde9dc]/30 px-3 py-2.5 ring-1 ring-[#c9652e]/30 ring-inset"
        >
          <Inbox className="mt-0.5 size-4 shrink-0 text-[#7a3d18]" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="truncate text-sm font-medium text-[#40233f]">
                {e.subject || '(no subject)'}
              </span>
              {e.classificationIntent && (
                <span className="text-[11px] text-muted-foreground capitalize">
                  · {e.classificationIntent.replace(/_/g, ' ')}
                </span>
              )}
              {e.spamTier === 'high_risk' && (
                <span className="text-[11px] font-semibold text-[#8a3942]">
                  · HIGH RISK
                </span>
              )}
            </div>
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
              from {e.fromAddress}
            </p>
          </div>
          <Button asChild variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-xs">
            <Link to="/mail">
              Triage
              <ChevronRight className="size-3" />
            </Link>
          </Button>
        </li>
      ))}
    </ul>
  )
}
