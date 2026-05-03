import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import {
  Bell,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Search,
  Sparkles,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { Input } from '@/components/ui/input'
import { AppSidebar } from './app-sidebar'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'

export type Crumb = { label: string; to?: string }

type AppShellProps = {
  isAuthenticated: boolean
  /**
   * Legacy: a single label used as the final breadcrumb when no `breadcrumb` is
   * given.
   */
  title?: string
  /** Optional context line shown beneath the breadcrumb. */
  subtitle?: string
  /** Explicit breadcrumb path. Overrides `title` and auto-derivation. */
  breadcrumb?: ReadonlyArray<Crumb>
  /** Page-specific actions rendered on the right of the top row. */
  actions?: React.ReactNode
  /**
   * Hide the sticky top header (breadcrumb, search, notifications, actions).
   * Used by pre-tenant flows like the org picker where the chrome would be
   * misleading or empty.
   */
  noHeader?: boolean
  children: React.ReactNode
}

export function AppShell({
  isAuthenticated,
  title,
  subtitle,
  breadcrumb,
  actions,
  noHeader = false,
  children,
}: AppShellProps) {
  const location = useLocation()

  const crumbs: ReadonlyArray<Crumb> = useMemo(() => {
    if (breadcrumb && breadcrumb.length > 0) return breadcrumb
    const derived = deriveBreadcrumb(location.pathname)
    if (title) {
      // If a page passes title only, use the derived path but replace the
      // last label with the explicit title so the page can override it.
      return derived.length > 0
        ? [
            ...derived.slice(0, -1),
            { ...derived[derived.length - 1]!, label: title },
          ]
        : [{ label: title }]
    }
    return derived
  }, [breadcrumb, location.pathname, title])

  return (
    <SidebarProvider>
      {isAuthenticated && <AppSidebar isAuthenticated={isAuthenticated} />}
      <SidebarInset className="bg-background">
        {!noHeader && (
          <header className="sticky top-0 z-10 flex flex-col border-b border-border/60 bg-background/85 px-4 py-3 backdrop-blur lg:px-8">
            <div className="flex items-center gap-3">
              {isAuthenticated && (
                <SidebarTrigger className="-ml-1 lg:hidden" />
              )}
              <Breadcrumb crumbs={crumbs} />
              <div className="ml-auto flex items-center gap-2">
                {isAuthenticated && <GlobalSearch />}
                {isAuthenticated && <NotificationsBell />}
                {actions}
              </div>
            </div>
            {subtitle && (
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            )}
          </header>
        )}

        <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 lg:px-8">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}

// Pathname → breadcrumb. Pages can override by passing the `breadcrumb` prop.
function deriveBreadcrumb(pathname: string): ReadonlyArray<Crumb> {
  if (pathname === '/') return [{ label: 'Dashboard' }]
  if (pathname === '/files') return [{ label: 'Files' }]
  if (/^\/files\/[^/]+/.test(pathname)) {
    return [{ label: 'Files', to: '/files' }, { label: 'File' }]
  }
  if (pathname === '/admin') return [{ label: 'Admin' }]
  if (pathname === '/admin/rules') {
    return [{ label: 'Admin', to: '/admin' }, { label: 'Recording rules' }]
  }
  if (pathname === '/admin/integrations') {
    return [{ label: 'Admin', to: '/admin' }, { label: 'Integrations' }]
  }
  if (pathname === '/settings') return [{ label: 'Settings' }]
  if (pathname === '/tenants') return [{ label: 'Organizations' }]
  return []
}

function Breadcrumb({ crumbs }: { crumbs: ReadonlyArray<Crumb> }) {
  if (crumbs.length === 0) return null
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
      <ol className="flex flex-wrap items-center gap-1.5 text-sm">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1
          const labelClass = last
            ? 'font-medium text-[#40233f]'
            : 'text-muted-foreground'
          return (
            <li key={`${c.label}-${i}`} className="flex items-center gap-1.5">
              {c.to && !last ? (
                <Link
                  to={c.to}
                  className="text-muted-foreground transition hover:text-[#40233f]"
                >
                  {c.label}
                </Link>
              ) : (
                <span className={`truncate ${labelClass}`}>{c.label}</span>
              )}
              {!last && (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/40" />
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

// Flat list shape used for keyboard navigation through the search popover.
type FlatResult =
  | { kind: 'file'; fileId: string; title: string; meta: string }
  | {
      kind: 'party'
      title: string
      meta: string
      fileId: string | null
    }
  | { kind: 'finding'; fileId: string; title: string; meta: string }

function GlobalSearch() {
  const navigate = useNavigate()
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const trimmed = q.trim()

  const tenant = useQuery({
    ...convexQuery(api.tenants.current, {}),
    retry: false,
  })
  const hasTenant = !!tenant.data && !tenant.error
  const enabled = hasTenant && trimmed.length >= 2

  const results = useQuery({
    ...convexQuery(api.search.global, { q: trimmed }),
    enabled,
  })

  const data = results.data
  const showPanel = open && enabled

  // Flatten results so arrow keys can move through every row regardless of
  // group. Disabled rows (parties without a fileId) are excluded — we can't
  // navigate to them.
  const flat: ReadonlyArray<FlatResult> = useMemo(() => {
    if (!data) return []
    const out: FlatResult[] = []
    for (const f of data.files) {
      out.push({
        kind: 'file',
        fileId: f._id,
        title: f.fileNumber,
        meta: `${f.transactionType} · ${f.status}`,
      })
    }
    for (const p of data.parties) {
      if (!p.fileId) continue
      out.push({
        kind: 'party',
        title: p.legalName,
        meta: p.fileNumber
          ? `${p.partyType} · on ${p.fileNumber}`
          : p.partyType,
        fileId: p.fileId,
      })
    }
    for (const fd of data.findings) {
      out.push({
        kind: 'finding',
        fileId: fd.fileId,
        title: fd.message,
        meta: `${fd.severity} · ${fd.findingType}${fd.fileNumber ? ` · ${fd.fileNumber}` : ''}`,
      })
    }
    return out
  }, [data])

  // Reset selection whenever the result set changes.
  useEffect(() => {
    setSelectedIndex(0)
  }, [flat.length, open])

  // Outside-click closes the popover.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    return () => document.removeEventListener('mousedown', onPointer)
  }, [open])

  // Global ⌘K / Ctrl+K to focus the search input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
        if (trimmed.length >= 2) setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [trimmed.length])

  const close = () => {
    setOpen(false)
    setQ('')
  }

  const gotoFile = (fileId: Id<'files'>) => {
    close()
    navigate({ to: '/files/$fileId', params: { fileId } })
  }

  const activate = (i: number) => {
    const r = flat[i]
    if (!r) return
    gotoFile(r.fileId as Id<'files'>)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      inputRef.current?.blur()
      return
    }
    if (!showPanel || flat.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => (i + 1) % flat.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => (i - 1 + flat.length) % flat.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(selectedIndex)
    }
  }

  const isEmpty =
    showPanel &&
    !!data &&
    data.files.length === 0 &&
    data.parties.length === 0 &&
    data.findings.length === 0

  return (
    <div
      ref={containerRef}
      className="relative flex w-72 max-w-full items-center gap-2 rounded-xl border border-input bg-card px-3 py-1.5 shadow-xs sm:w-80"
    >
      <Search className="size-4 shrink-0 text-muted-foreground" />
      <Input
        ref={inputRef}
        className="h-7 border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
        placeholder="Search files, parties, findings..."
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
        onFocus={() => {
          if (trimmed.length >= 2) setOpen(true)
        }}
        onKeyDown={onKeyDown}
        aria-controls="global-search-results"
        aria-expanded={showPanel}
      />
      <kbd className="hidden shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground sm:inline-block">
        ⌘K
      </kbd>
      {showPanel && (
        <div
          id="global-search-results"
          role="listbox"
          className="absolute top-full right-0 left-0 z-50 mt-2 max-h-[60vh] overflow-y-auto rounded-2xl bg-popover p-2 text-popover-foreground shadow-lg ring-1 ring-foreground/5"
        >
          {results.isLoading && !data && (
            <div className="px-3 py-4 text-sm text-muted-foreground">
              Searching...
            </div>
          )}
          {isEmpty && (
            <div className="px-3 py-4 text-sm text-muted-foreground">
              No matches for "{trimmed}".
            </div>
          )}
          {data && flat.length > 0 && (
            <FlatResultList
              results={data}
              flat={flat}
              selectedIndex={selectedIndex}
              onHover={setSelectedIndex}
              onSelect={activate}
            />
          )}
          {flat.length > 0 && (
            <div className="mt-1 flex items-center justify-between border-t border-border/40 px-3 pt-2 text-[10px] text-muted-foreground">
              <span>
                <kbd className="rounded border border-border bg-muted px-1 font-mono">
                  ↑↓
                </kbd>{' '}
                navigate ·{' '}
                <kbd className="rounded border border-border bg-muted px-1 font-mono">
                  ↵
                </kbd>{' '}
                open ·{' '}
                <kbd className="rounded border border-border bg-muted px-1 font-mono">
                  esc
                </kbd>{' '}
                close
              </span>
              <span className="font-numerals tabular-nums">
                {flat.length} {flat.length === 1 ? 'result' : 'results'}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function FlatResultList({
  results,
  flat,
  selectedIndex,
  onHover,
  onSelect,
}: {
  results: {
    files: ReadonlyArray<{
      _id: string
      fileNumber: string
      transactionType: string
      status: string
    }>
    parties: ReadonlyArray<{
      partyId: string
      legalName: string
      partyType: string
      fileId: string | null
      fileNumber: string | null
    }>
    findings: ReadonlyArray<{
      findingId: string
      fileId: string
      message: string
      severity: string
      findingType: string
      fileNumber: string | null
    }>
  }
  flat: ReadonlyArray<FlatResult>
  selectedIndex: number
  onHover: (i: number) => void
  onSelect: (i: number) => void
}) {
  // Iterate over flat for selection mapping. Group rendering follows the
  // order files → parties → findings.
  let cursor = 0
  const sections: React.ReactElement[] = []

  if (results.files.length > 0) {
    const start = cursor
    cursor += results.files.length
    sections.push(
      <ResultGroup key="files" label="Files">
        {results.files.map((f, i) => {
          const idx = start + i
          return (
            <ResultRow
              key={f._id}
              title={f.fileNumber}
              meta={`${f.transactionType} · ${f.status}`}
              selected={idx === selectedIndex}
              onMouseMove={() => onHover(idx)}
              onSelect={() => onSelect(idx)}
            />
          )
        })}
      </ResultGroup>
    )
  }

  const navigableParties = results.parties.filter((p) => !!p.fileId)
  if (navigableParties.length > 0) {
    const start = cursor
    cursor += navigableParties.length
    sections.push(
      <ResultGroup key="parties" label="Parties">
        {navigableParties.map((p, i) => {
          const idx = start + i
          return (
            <ResultRow
              key={p.partyId}
              title={p.legalName}
              meta={
                p.fileNumber
                  ? `${p.partyType} · on ${p.fileNumber}`
                  : p.partyType
              }
              selected={idx === selectedIndex}
              onMouseMove={() => onHover(idx)}
              onSelect={() => onSelect(idx)}
            />
          )
        })}
      </ResultGroup>
    )
  }

  // Show un-navigable parties as informational footnotes (not selectable).
  const unattachedParties = results.parties.filter((p) => !p.fileId)

  if (results.findings.length > 0) {
    const start = cursor
    cursor += results.findings.length
    sections.push(
      <ResultGroup key="findings" label="Findings">
        {results.findings.map((fd, i) => {
          const idx = start + i
          return (
            <ResultRow
              key={fd.findingId}
              title={fd.message}
              meta={`${fd.severity} · ${fd.findingType}${fd.fileNumber ? ` · ${fd.fileNumber}` : ''}`}
              selected={idx === selectedIndex}
              onMouseMove={() => onHover(idx)}
              onSelect={() => onSelect(idx)}
            />
          )
        })}
      </ResultGroup>
    )
  }

  // Avoid an unused-var warning when there are no unattached parties.
  void flat

  return (
    <div className="flex flex-col gap-1">
      {sections}
      {unattachedParties.length > 0 && (
        <div className="px-3 pt-1 text-[10px] text-muted-foreground">
          {unattachedParties.length} unattached part
          {unattachedParties.length === 1 ? 'y' : 'ies'} — not yet on a file.
        </div>
      )}
    </div>
  )
}

function ResultGroup({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col">
      <div className="px-3 py-1 text-xs font-medium text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  )
}

function ResultRow({
  title,
  meta,
  selected,
  onSelect,
  onMouseMove,
}: {
  title: string
  meta?: string
  selected?: boolean
  onSelect: () => void
  onMouseMove?: () => void
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSelect}
      onMouseMove={onMouseMove}
      className={`flex w-full flex-col items-start gap-0.5 rounded-xl px-3 py-2 text-left text-sm font-normal transition ${
        selected ? 'bg-[#fdf6e8]' : 'hover:bg-muted'
      }`}
    >
      <span className="line-clamp-1 w-full font-medium text-[#2e2430]">
        {title}
      </span>
      {meta && (
        <span className="w-full text-xs text-muted-foreground">{meta}</span>
      )}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Notifications bell
// ─────────────────────────────────────────────────────────────────────

type NotificationRow = {
  _id: string
  kind: string
  title: string
  body?: string
  severity?: string | null
  fileId?: string | null
  occurredAt: number
  readAt?: number | null
}

function NotificationsBell() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const navigate = useNavigate()

  // Skip when there's no active tenant — both queries require one.
  const tenant = useQuery({
    ...convexQuery(api.tenants.current, {}),
    retry: false,
  })
  const hasTenant = !!tenant.data && !tenant.error

  const list = useQuery({
    ...convexQuery(api.notifications.listForMe, { limit: 30 }),
    enabled: hasTenant,
    retry: false,
  })
  const unreadQ = useQuery({
    ...convexQuery(api.notifications.unreadCount, {}),
    enabled: hasTenant,
    retry: false,
  })
  const markRead = useConvexMutation(api.notifications.markRead)
  const markAllRead = useConvexMutation(api.notifications.markAllRead)
  const dismissAll = useConvexMutation(api.notifications.dismissAll)

  const items = (list.data ?? []) as ReadonlyArray<NotificationRow>
  const unread = (unreadQ.data ?? 0) as number

  // Outside-click to dismiss.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    return () => document.removeEventListener('mousedown', onPointer)
  }, [open])

  // Reset the inline "are you sure?" state whenever the popover closes.
  useEffect(() => {
    if (!open) setConfirmingClear(false)
  }, [open])

  if (!hasTenant) return null

  const onItemClick = async (n: NotificationRow) => {
    setOpen(false)
    if (!n.readAt) {
      try {
        await markRead({ notificationId: n._id as Id<'notifications'> })
      } catch {
        // ignore — UI doesn't depend on success.
      }
    }
    if (n.fileId) {
      navigate({ to: '/files/$fileId', params: { fileId: n.fileId } })
    }
  }

  const onMarkAll = async () => {
    try {
      await markAllRead({})
    } catch {
      // ignore
    }
  }

  const onClearAll = async () => {
    // First click arms the confirmation; second click commits. Resets when
    // the popover closes or after a few seconds of inactivity.
    if (!confirmingClear) {
      setConfirmingClear(true)
      return
    }
    setConfirmingClear(false)
    try {
      await dismissAll({})
    } catch {
      // ignore
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ''}`}
        aria-expanded={open}
        className={`relative inline-flex size-9 items-center justify-center rounded-xl border border-input bg-card text-[#40233f] transition hover:bg-[#fdf6e8] ${
          open ? 'ring-2 ring-[#593157]/30' : ''
        }`}
      >
        <Bell className="size-4" />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#b94f58] px-1 text-[10px] leading-none font-semibold text-white ring-2 ring-background">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute top-full right-0 z-50 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border/70 bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/5"
        >
          <header className="flex items-center justify-between gap-3 border-b border-border/60 bg-[#fdf6e8]/60 px-4 py-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-[#b78625]">
                Notifications
              </div>
              <div className="font-display text-base leading-none font-semibold tracking-tight text-[#40233f]">
                What's new
              </div>
            </div>
            {items.length > 0 && (
              <div className="flex shrink-0 items-center gap-1">
                {!confirmingClear && unread > 0 && (
                  <button
                    type="button"
                    onClick={onMarkAll}
                    className="rounded-full px-2 py-1 text-xs font-medium text-[#40233f] transition hover:bg-card"
                  >
                    Mark all read
                  </button>
                )}
                {confirmingClear ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setConfirmingClear(false)}
                      className="rounded-full px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-card hover:text-[#40233f]"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={onClearAll}
                      autoFocus
                      className="rounded-full bg-[#b94f58] px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-[#a04249]"
                    >
                      Clear {items.length}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={onClearAll}
                    className="rounded-full px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-card hover:text-[#8a3942]"
                  >
                    Clear all
                  </button>
                )}
              </div>
            )}
          </header>

          <div className="max-h-[60vh] overflow-y-auto">
            {list.isLoading && !list.data ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                Loading...
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <Bell className="size-5 text-muted-foreground/50" />
                <div className="text-sm font-medium text-[#40233f]">
                  No notifications yet
                </div>
                <div className="text-xs text-muted-foreground">
                  We'll buzz when extractions finish, findings appear, or files
                  change state.
                </div>
              </div>
            ) : (
              <ol className="divide-y divide-border/40">
                {items.map((n) => (
                  <NotificationRowView
                    key={n._id}
                    n={n}
                    onClick={() => onItemClick(n)}
                  />
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function NotificationRowView({
  n,
  onClick,
}: {
  n: NotificationRow
  onClick: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const titleRef = useRef<HTMLSpanElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Measure whether the clamped title/body actually overflow so we only show
  // the toggle when there's hidden content. Re-runs when the row collapses
  // back so a fresh measurement reflects the clamped state.
  useEffect(() => {
    if (expanded) return
    const measure = () => {
      const t = titleRef.current
      const b = bodyRef.current
      const titleOver = !!t && t.scrollWidth > t.clientWidth + 1
      const bodyOver = !!b && b.scrollHeight > b.clientHeight + 1
      setOverflows(titleOver || bodyOver)
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (titleRef.current) ro.observe(titleRef.current)
    if (bodyRef.current) ro.observe(bodyRef.current)
    return () => ro.disconnect()
  }, [expanded, n.title, n.body])

  const tone =
    n.severity === 'block'
      ? {
          bg: 'bg-[#fdecee]',
          text: 'text-[#8a3942]',
          icon: <CircleAlert className="size-3.5" />,
        }
      : n.severity === 'warn'
        ? {
            bg: 'bg-[#fde9dc]',
            text: 'text-[#7a3d18]',
            icon: <CircleAlert className="size-3.5" />,
          }
        : n.severity === 'ok'
          ? {
              bg: 'bg-[#e6f3ed]',
              text: 'text-[#2f5d4b]',
              icon: <CheckCircle2 className="size-3.5" />,
            }
          : n.kind.startsWith('extraction')
            ? {
                bg: 'bg-[#fdf6e8]',
                text: 'text-[#7a5818]',
                icon: <Sparkles className="size-3.5" />,
              }
            : {
                bg: 'bg-muted',
                text: 'text-muted-foreground',
                icon: <Check className="size-3.5" />,
              }

  const unread = !n.readAt
  const showToggle = overflows || expanded
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onClick()
          }
        }}
        className={`group/notif flex w-full cursor-pointer items-start gap-3 px-4 py-2.5 text-left transition hover:bg-[#fdf6e8]/50 focus:outline-none focus-visible:bg-[#fdf6e8]/60 ${
          unread ? 'bg-[#fdf6e8]/30' : ''
        }`}
      >
        <div
          className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full ring-1 ring-inset ${tone.bg} ${tone.text}`}
        >
          {tone.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span
              ref={titleRef}
              className={`text-sm font-medium text-[#2e2430] ${
                expanded ? 'break-words' : 'truncate'
              }`}
            >
              {n.title}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {bellTimeAgo(n.occurredAt)}
            </span>
          </div>
          {n.body && (
            <div
              ref={bodyRef}
              className={`mt-0.5 text-xs text-muted-foreground ${
                expanded ? 'whitespace-pre-wrap break-words' : 'line-clamp-1'
              }`}
            >
              {n.body}
            </div>
          )}
          {showToggle && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setExpanded((v) => !v)
              }}
              className="mt-1 text-[11px] font-medium text-[#593157] transition hover:text-[#40233f] hover:underline"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 self-center">
          {unread && (
            <span
              aria-label="Unread"
              className="size-1.5 rounded-full bg-[#b94f58]"
            />
          )}
          {n.fileId && (
            <ChevronRight className="size-3.5 text-muted-foreground/40 transition group-hover/notif:translate-x-0.5 group-hover/notif:text-[#40233f]" />
          )}
        </div>
      </div>
    </li>
  )
}

function bellTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 5_000) return 'just now'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}
