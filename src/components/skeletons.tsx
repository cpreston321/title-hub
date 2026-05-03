import { Skeleton } from '@/components/ui/skeleton'

// Layout-matching placeholders. Tuned to mirror each page's first paint so
// the structure is stable when real data arrives — no layout shift, no
// "blank screen" flash.

export function PageHeaderSkeleton({
  withSubtitle = true,
}: {
  withSubtitle?: boolean
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Skeleton className="h-10 w-48 md:h-12 md:w-64" />
          {withSubtitle && (
            <Skeleton className="mt-3 h-4 w-full max-w-md rounded" />
          )}
        </div>
        <Skeleton className="h-9 w-28 rounded-md" />
      </div>
    </div>
  )
}

export function KpiStripSkeleton({ tiles = 4 }: { tiles?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {Array.from({ length: tiles }).map((_, i) => (
        <div
          key={i}
          className="flex flex-col gap-2 rounded-2xl border border-border/70 bg-card px-4 py-3 shadow-sm ring-1 ring-foreground/5"
        >
          <Skeleton className="h-3 w-20 rounded" />
          <Skeleton className="h-7 w-12 rounded" />
          <Skeleton className="h-3 w-24 rounded" />
        </div>
      ))}
    </div>
  )
}

export function TableSkeleton({
  rows = 6,
  cols = 5,
  withHeader = true,
}: {
  rows?: number
  cols?: number
  withHeader?: boolean
}) {
  const colClass =
    cols === 5
      ? 'grid-cols-[3rem_1fr_8rem_5rem_5.5rem]'
      : cols === 4
        ? 'grid-cols-[1fr_8rem_5rem_5.5rem]'
        : 'grid-cols-[1fr_8rem_5.5rem]'
  return (
    <article className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/5">
      {withHeader && (
        <header className="flex items-center justify-between border-b border-border/70 px-6 py-4">
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-5 w-28 rounded" />
            <Skeleton className="h-3 w-56 rounded" />
          </div>
          <Skeleton className="h-7 w-20 rounded-md" />
        </header>
      )}
      <ol className="divide-y divide-border/60">
        {Array.from({ length: rows }).map((_, i) => (
          <li
            key={i}
            className={`grid ${colClass} items-center gap-4 px-6 py-3.5`}
          >
            {Array.from({ length: cols }).map((__, j) => (
              <Skeleton
                key={j}
                className={`h-4 ${j === 0 ? 'w-10' : j === 1 ? 'w-3/4' : 'w-full'} rounded`}
              />
            ))}
          </li>
        ))}
      </ol>
    </article>
  )
}

export function CardListSkeleton({
  count = 4,
  height = 'h-28',
}: {
  count?: number
  height?: string
}) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={`rounded-2xl border border-border/60 bg-card ${height} shadow-sm ring-1 ring-foreground/5`}
        >
          <div className="flex h-full flex-col justify-between p-5">
            <div className="flex items-center gap-3">
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-1/3 rounded" />
                <Skeleton className="h-3 w-1/2 rounded" />
              </div>
              <Skeleton className="h-6 w-16 rounded-full" />
            </div>
            <Skeleton className="h-3 w-3/4 rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function ToolbarSkeleton() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border/60 bg-card px-3 py-2 shadow-sm ring-1 ring-foreground/5">
      <Skeleton className="h-8 w-64 rounded-md" />
      <Skeleton className="h-8 w-28 rounded-md" />
      <Skeleton className="h-8 w-24 rounded-md" />
      <div className="ml-auto">
        <Skeleton className="h-3 w-20 rounded" />
      </div>
    </div>
  )
}

export function PipelineStripSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm ring-1 ring-foreground/5">
      <div className="grid grid-cols-2 gap-px sm:grid-cols-4 md:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col gap-1.5 bg-card px-4 py-3"
          >
            <Skeleton className="h-3 w-16 rounded" />
            <Skeleton className="h-6 w-8 rounded" />
            <Skeleton className="h-3 w-20 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}

// Two-column dashboard: main register + side panel.
export function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6 pb-12">
      <PageHeaderSkeleton />
      <KpiStripSkeleton />
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <TableSkeleton rows={6} cols={5} />
        </div>
        <aside className="lg:col-span-4">
          <CardListSkeleton count={3} height="h-20" />
        </aside>
      </section>
    </div>
  )
}

// Full files-list page placeholder.
export function FilesListSkeleton() {
  return (
    <div className="flex flex-col gap-6 pb-12">
      <PageHeaderSkeleton />
      <PipelineStripSkeleton />
      <ToolbarSkeleton />
      <TableSkeleton rows={8} cols={5} />
    </div>
  )
}

// File detail page — header, tabs, and a docket of cards.
export function FileDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6 pb-12">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24 rounded" />
        <Skeleton className="h-10 w-2/3 rounded md:h-12" />
        <Skeleton className="h-4 w-1/2 rounded" />
      </div>
      <div className="flex gap-2 border-b border-border/60 pb-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-md" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="rounded-2xl border border-border/60 bg-card p-5 shadow-sm ring-1 ring-foreground/5"
          >
            <Skeleton className="h-3 w-20 rounded" />
            <Skeleton className="mt-3 h-6 w-3/4 rounded" />
            <Skeleton className="mt-2 h-3 w-full rounded" />
            <Skeleton className="mt-1.5 h-3 w-4/5 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}

// Section with a colored header and a list of items.
export function SectionSkeleton({
  rows = 3,
  withHeader = true,
}: {
  rows?: number
  withHeader?: boolean
}) {
  return (
    <article className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/5">
      {withHeader && (
        <header className="flex items-center gap-3 border-b border-border/70 px-6 py-4">
          <Skeleton className="size-7 rounded-md" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-32 rounded" />
            <Skeleton className="h-3 w-48 rounded" />
          </div>
          <Skeleton className="h-5 w-10 rounded-full" />
        </header>
      )}
      <ol className="divide-y divide-border/50">
        {Array.from({ length: rows }).map((_, i) => (
          <li key={i} className="flex items-center gap-3 px-6 py-3.5">
            <Skeleton className="size-6 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-2/3 rounded" />
              <Skeleton className="h-3 w-1/3 rounded" />
            </div>
            <Skeleton className="h-4 w-16 rounded" />
          </li>
        ))}
      </ol>
    </article>
  )
}

// Inbox / mail layout with a list rail and a detail panel.
export function MailSkeleton() {
  return (
    <div className="grid h-full grid-cols-1 gap-4 lg:grid-cols-[22rem_1fr]">
      <aside className="flex flex-col gap-2">
        <ToolbarSkeleton />
        <div className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/5">
          <ol className="divide-y divide-border/50">
            {Array.from({ length: 7 }).map((_, i) => (
              <li key={i} className="flex flex-col gap-1.5 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <Skeleton className="h-3 w-24 rounded" />
                  <Skeleton className="h-3 w-12 rounded" />
                </div>
                <Skeleton className="h-4 w-3/4 rounded" />
                <Skeleton className="h-3 w-2/3 rounded" />
              </li>
            ))}
          </ol>
        </div>
      </aside>
      <section className="rounded-2xl border border-border/60 bg-card p-6 shadow-sm ring-1 ring-foreground/5">
        <Skeleton className="h-3 w-24 rounded" />
        <Skeleton className="mt-2 h-6 w-2/3 rounded" />
        <Skeleton className="mt-1.5 h-3 w-1/3 rounded" />
        <div className="mt-6 flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-3 w-full rounded" />
          ))}
        </div>
      </section>
    </div>
  )
}
