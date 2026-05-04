import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import {
  ArrowRight,
  Bell,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CornerDownLeft,
  FileText,
  Mail,
  Paperclip,
  Search,
  Sparkles,
  User,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useAnimate } from 'motion/react'

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
          <header className="sticky top-0 z-20 flex flex-col border-b border-border/60 bg-background/85 px-4 py-3 backdrop-blur lg:px-8">
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
  if (pathname === '/queue') return [{ label: 'My queue' }]
  if (pathname === '/closing') return [{ label: 'Closing day' }]
  if (pathname === '/history') return [{ label: 'History' }]
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
  if (pathname === '/admin/reconciliation') {
    return [
      { label: 'Admin', to: '/admin' },
      { label: 'Reconciliation policy' },
    ]
  }
  if (pathname === '/admin/file-numbering') {
    return [
      { label: 'Admin', to: '/admin' },
      { label: 'File numbering' },
    ]
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
  | {
      kind: 'document'
      fileId: string | null
      title: string
      meta: string
    }
  | { kind: 'email'; fileId: string | null; title: string; meta: string }
  | {
      kind: 'action'
      title: string
      meta: string
      run: () => void
    }

function GlobalSearch() {
  const navigate = useNavigate()
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  // Below sm, the inline search bar is hidden behind an icon trigger so it
  // doesn't crowd the breadcrumb. Tapping the icon opens a fixed top overlay
  // that contains the same input/results.
  const [mobileOpen, setMobileOpen] = useState(false)
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

  const navigateToMail = () => {
    setOpen(false)
    setQ('')
    navigate({ to: '/mail' })
  }
  const navigateToFiles = () => {
    setOpen(false)
    setQ('')
    navigate({ to: '/files' })
  }

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
    if ('documents' in data) {
      for (const d of data.documents ?? []) {
        out.push({
          kind: 'document',
          fileId: d.fileId,
          title: d.title ?? d.docType.replace(/_/g, ' '),
          meta: d.fileNumber
            ? `${d.docType.replace(/_/g, ' ')} · on ${d.fileNumber}`
            : d.docType.replace(/_/g, ' '),
        })
      }
    }
    if ('emails' in data) {
      for (const e of data.emails ?? []) {
        const intent = e.classificationIntent
          ? ` · ${e.classificationIntent.replace(/_/g, ' ')}`
          : ''
        out.push({
          kind: 'email',
          fileId: e.matchedFileId,
          title: e.subject || '(no subject)',
          meta: `from ${e.fromAddress}${intent}`,
        })
      }
    }
    // Action items, surfaced when the query looks like a verb. Cheap and
    // discoverable; we won't ship a full command grammar in v1.
    const lower = trimmed.toLowerCase()
    if (lower.startsWith('mail') || lower === 'inbox') {
      out.push({
        kind: 'action',
        title: 'Open inbound mail',
        meta: 'Navigate to /mail',
        run: navigateToMail,
      })
    }
    if (lower.startsWith('files') || lower === 'home') {
      out.push({
        kind: 'action',
        title: 'Open all files',
        meta: 'Navigate to /files',
        run: navigateToFiles,
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, trimmed])

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

  // Focus the input as soon as the mobile overlay opens, and lock body scroll
  // so the page underneath stays put while the user types.
  useEffect(() => {
    if (!mobileOpen) return
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      clearTimeout(t)
      document.body.style.overflow = prevOverflow
    }
  }, [mobileOpen])

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
    if (r.kind === 'action') {
      r.run()
      return
    }
    if (r.kind === 'email' && !r.fileId) {
      navigateToMail()
      return
    }
    if (r.kind === 'document' && !r.fileId) {
      // Orphan documents land in the inbox triage queue.
      navigateToMail()
      return
    }
    if (!r.fileId) return
    gotoFile(r.fileId as Id<'files'>)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      setMobileOpen(false)
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
    data.findings.length === 0 &&
    (!('documents' in data) || data.documents.length === 0) &&
    (!('emails' in data) || data.emails.length === 0)

  const SearchInputAndPanel = (
    <>
      <Search className="size-4 shrink-0 text-muted-foreground" />
      <Input
        ref={inputRef}
        className="h-7 border-0 bg-transparent p-0 text-base shadow-none focus-visible:ring-0 sm:text-sm"
        placeholder="Search files, mail, parties, findings…"
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
          className="absolute top-full right-0 left-0 z-50 mt-2 max-h-[70vh] w-full overflow-y-auto rounded-2xl bg-popover p-2 text-popover-foreground shadow-lg ring-1 ring-foreground/5 sm:left-auto sm:w-[36rem] sm:max-w-[calc(100vw-2rem)]"
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
              query={trimmed}
              selectedIndex={selectedIndex}
              onHover={setSelectedIndex}
              onSelect={activate}
            />
          )}
          {flat.length > 0 && (
            <div className="mt-1 hidden items-center justify-between border-t border-border/40 px-3 pt-2 text-[10px] text-muted-foreground sm:flex">
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
    </>
  )

  return (
    <>
      {/* Inline search bar — visible at sm+ where there's room. */}
      <div
        ref={containerRef}
        className="relative hidden w-72 max-w-full items-center gap-2 rounded-xl border border-input bg-card px-3 py-1.5 shadow-xs sm:flex sm:w-80"
      >
        {SearchInputAndPanel}
      </div>

      {/* Mobile-only icon trigger. */}
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label="Open search"
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl border border-input bg-card text-[#40233f] transition hover:bg-[#fdf6e8] sm:hidden"
      >
        <Search className="size-4" />
      </button>

      {/* Mobile overlay — fixed at the top of the viewport with a scrim
          beneath. The same input/results panel renders inside. */}
      {mobileOpen && (
        <div
          role="dialog"
          aria-label="Search"
          className="fixed inset-0 z-50 sm:hidden"
        >
          <div
            aria-hidden
            className="absolute inset-0 bg-foreground/30 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative mx-auto mt-3 flex w-[calc(100vw-1rem)] flex-col gap-2 px-2">
            <div
              ref={containerRef}
              className="relative flex items-center gap-2 rounded-xl border border-input bg-card px-3 py-2 shadow-lg"
            >
              {SearchInputAndPanel}
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close search"
                className="ml-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-[#40233f]"
              >
                <span aria-hidden className="text-base leading-none">
                  ×
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function FlatResultList({
  results,
  flat,
  query,
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
      propertyApn?: string | null
      propertyAddress?: {
        line1: string
        line2: string | null
        city: string
        state: string
        zip: string
      } | null
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
    documents?: ReadonlyArray<{
      documentId: string
      fileId: string | null
      fileNumber: string | null
      title: string | null
      docType: string
      uploadedAt: number
    }>
    emails?: ReadonlyArray<{
      inboundEmailId: string
      subject: string
      fromAddress: string
      fromName: string | null
      receivedAt: number
      status: string
      matchedFileId: string | null
      classificationIntent: string | null
    }>
  }
  flat: ReadonlyArray<FlatResult>
  query: string
  selectedIndex: number
  onHover: (i: number) => void
  onSelect: (i: number) => void
}) {
  // Iterate over flat for selection mapping. Group rendering follows the
  // order files → parties → findings → documents → emails → actions.
  let cursor = 0
  const sections: React.ReactElement[] = []

  if (results.files.length > 0) {
    const start = cursor
    cursor += results.files.length
    sections.push(
      <ResultGroup key="files" label="Files" count={results.files.length}>
        {results.files.map((f, i) => {
          const idx = start + i
          const addressLine = formatAddress(f.propertyAddress)
          return (
            <ResultRow
              key={f._id}
              icon={
                <ResultIcon tone="violet">
                  <FileText className="size-3.5" />
                </ResultIcon>
              }
              title={<Highlight text={f.fileNumber} query={query} />}
              badge={
                <Chip tone={fileStatusTone(f.status)}>
                  {humanize(f.status)}
                </Chip>
              }
              meta={
                <>
                  <span className="capitalize">
                    {humanize(f.transactionType)}
                  </span>
                  {addressLine && (
                    <>
                      {' · '}
                      <Highlight text={addressLine} query={query} />
                    </>
                  )}
                  {!addressLine && f.propertyApn && (
                    <>
                      {' · APN '}
                      <Highlight text={f.propertyApn} query={query} />
                    </>
                  )}
                </>
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

  const navigableParties = results.parties.filter((p) => !!p.fileId)
  if (navigableParties.length > 0) {
    const start = cursor
    cursor += navigableParties.length
    sections.push(
      <ResultGroup
        key="parties"
        label="Parties"
        count={navigableParties.length}
      >
        {navigableParties.map((p, i) => {
          const idx = start + i
          return (
            <ResultRow
              key={p.partyId}
              icon={
                <ResultIcon tone="teal">
                  <User className="size-3.5" />
                </ResultIcon>
              }
              title={<Highlight text={p.legalName} query={query} />}
              badge={<Chip tone="neutral">{humanize(p.partyType)}</Chip>}
              meta={
                p.fileNumber ? (
                  <span className="inline-flex items-center gap-1">
                    <span>on</span>
                    <FilePill>{p.fileNumber}</FilePill>
                  </span>
                ) : null
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

  const unattachedParties = results.parties.filter((p) => !p.fileId)

  if (results.findings.length > 0) {
    const start = cursor
    cursor += results.findings.length
    sections.push(
      <ResultGroup
        key="findings"
        label="Findings"
        count={results.findings.length}
      >
        {results.findings.map((fd, i) => {
          const idx = start + i
          const tone = severityTone(fd.severity)
          return (
            <ResultRow
              key={fd.findingId}
              icon={
                <ResultIcon tone={tone}>
                  <CircleAlert className="size-3.5" />
                </ResultIcon>
              }
              title={<Highlight text={fd.message} query={query} />}
              badge={
                <Chip tone={tone}>{humanize(fd.severity)}</Chip>
              }
              meta={
                <span className="inline-flex items-center gap-1">
                  <span>{humanize(fd.findingType)}</span>
                  {fd.fileNumber && (
                    <>
                      <span>·</span>
                      <FilePill>{fd.fileNumber}</FilePill>
                    </>
                  )}
                </span>
              }
              titleClamp={2}
              selected={idx === selectedIndex}
              onMouseMove={() => onHover(idx)}
              onSelect={() => onSelect(idx)}
            />
          )
        })}
      </ResultGroup>
    )
  }

  if (results.documents && results.documents.length > 0) {
    const start = cursor
    cursor += results.documents.length
    sections.push(
      <ResultGroup
        key="documents"
        label="Documents"
        count={results.documents.length}
      >
        {results.documents.map((d, i) => {
          const idx = start + i
          const titleStr = d.title ?? humanize(d.docType)
          return (
            <ResultRow
              key={d.documentId}
              icon={
                <ResultIcon tone="amber">
                  <Paperclip className="size-3.5" />
                </ResultIcon>
              }
              title={<Highlight text={titleStr} query={query} />}
              badge={<Chip tone="amber">{humanize(d.docType)}</Chip>}
              meta={
                d.fileNumber ? (
                  <span className="inline-flex items-center gap-1">
                    <span>on</span>
                    <FilePill>{d.fileNumber}</FilePill>
                  </span>
                ) : (
                  <span className="text-muted-foreground/80">In inbox</span>
                )
              }
              trailing={
                <span className="font-numerals tabular-nums">
                  {bellTimeAgo(d.uploadedAt)}
                </span>
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

  if (results.emails && results.emails.length > 0) {
    const start = cursor
    cursor += results.emails.length
    sections.push(
      <ResultGroup
        key="emails"
        label="Mail"
        count={results.emails.length}
      >
        {results.emails.map((e, i) => {
          const idx = start + i
          const fromLabel = e.fromName?.trim() || e.fromAddress
          const intent = e.classificationIntent
            ? humanize(e.classificationIntent)
            : null
          return (
            <ResultRow
              key={e.inboundEmailId}
              icon={
                <ResultIcon tone="violet">
                  <Mail className="size-3.5" />
                </ResultIcon>
              }
              title={
                <Highlight
                  text={e.subject || '(no subject)'}
                  query={query}
                />
              }
              badge={intent ? <Chip tone="violet">{intent}</Chip> : null}
              meta={
                <span className="inline-flex items-center gap-1">
                  <span className="truncate">
                    from <Highlight text={fromLabel} query={query} />
                  </span>
                  {!e.matchedFileId && (
                    <Chip tone="neutral">Unmatched</Chip>
                  )}
                </span>
              }
              trailing={
                <span className="font-numerals tabular-nums">
                  {bellTimeAgo(e.receivedAt)}
                </span>
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

  const actions = flat.filter((r) => r.kind === 'action')
  if (actions.length > 0) {
    const startIdx = flat.findIndex((r) => r.kind === 'action')
    sections.push(
      <ResultGroup key="actions" label="Actions">
        {actions.map((a, i) => {
          if (a.kind !== 'action') return null
          const idx = startIdx + i
          return (
            <ResultRow
              key={`action-${i}`}
              icon={
                <ResultIcon tone="neutral">
                  <ArrowRight className="size-3.5" />
                </ResultIcon>
              }
              title={a.title}
              meta={a.meta}
              selected={idx === selectedIndex}
              onMouseMove={() => onHover(idx)}
              onSelect={() => onSelect(idx)}
            />
          )
        })}
      </ResultGroup>
    )
  }

  return (
    <div className="flex flex-col gap-2">
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
  count,
  children,
}: {
  label: string
  count?: number
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-3 py-1">
        <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        {typeof count === 'number' && (
          <span className="font-numerals text-[10px] tabular-nums text-muted-foreground/70">
            {count}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  )
}

function ResultRow({
  icon,
  title,
  badge,
  meta,
  trailing,
  titleClamp = 1,
  selected,
  onSelect,
  onMouseMove,
}: {
  icon?: React.ReactNode
  title: React.ReactNode
  badge?: React.ReactNode
  meta?: React.ReactNode
  trailing?: React.ReactNode
  titleClamp?: 1 | 2
  selected?: boolean
  onSelect: () => void
  onMouseMove?: () => void
}) {
  const clampClass = titleClamp === 2 ? 'line-clamp-2' : 'line-clamp-1'
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSelect}
      onMouseMove={onMouseMove}
      className={`flex w-full items-start gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-normal transition ${
        selected ? 'bg-[#fdf6e8]' : 'hover:bg-muted'
      }`}
    >
      {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={`min-w-0 flex-1 ${clampClass} font-medium text-[#2e2430]`}
          >
            {title}
          </span>
          {badge && <span className="shrink-0">{badge}</span>}
        </div>
        {meta && (
          <span className="line-clamp-1 w-full text-xs text-muted-foreground">
            {meta}
          </span>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5 self-center pl-1 text-[10px] text-muted-foreground">
        {trailing}
        {selected && (
          <span className="hidden items-center gap-0.5 rounded border border-border/60 bg-card px-1 py-0.5 font-medium text-[#40233f] sm:inline-flex">
            <CornerDownLeft className="size-2.5" />
          </span>
        )}
      </div>
    </button>
  )
}

type ChipTone =
  | 'red'
  | 'orange'
  | 'green'
  | 'amber'
  | 'violet'
  | 'teal'
  | 'neutral'

function chipClasses(tone: ChipTone): string {
  switch (tone) {
    case 'red':
      return 'bg-[#fdecee] text-[#8a3942]'
    case 'orange':
      return 'bg-[#fde9dc] text-[#7a3d18]'
    case 'green':
      return 'bg-[#e6f3ed] text-[#2f5d4b]'
    case 'amber':
      return 'bg-[#fdf6e8] text-[#7a5818]'
    case 'violet':
      return 'bg-[#f1eaf3] text-[#593157]'
    case 'teal':
      return 'bg-[#e3f1f0] text-[#26595a]'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

function Chip({
  tone = 'neutral',
  children,
}: {
  tone?: ChipTone
  children: React.ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-medium capitalize ${chipClasses(tone)}`}
    >
      {children}
    </span>
  )
}

function ResultIcon({
  tone,
  children,
}: {
  tone: ChipTone
  children: React.ReactNode
}) {
  return (
    <span
      className={`grid size-6 place-items-center rounded-md ring-1 ring-inset ring-black/5 ${chipClasses(tone)}`}
    >
      {children}
    </span>
  )
}

function FilePill({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-numerals inline-flex items-center rounded border border-border/60 bg-card px-1 py-px font-mono text-[10px] tabular-nums text-[#40233f]">
      {children}
    </span>
  )
}

function Highlight({
  text,
  query,
}: {
  text: string
  query: string
}) {
  const q = query.trim()
  if (q.length < 2) return <>{text}</>
  // Escape regex metacharacters in user input. Case-insensitive global match
  // so each occurrence is wrapped.
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(${escaped})`, 'ig')
  const parts = text.split(re)
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === q.toLowerCase() ? (
          <mark
            key={i}
            className="rounded-sm bg-[#fdf6e8] px-0.5 font-semibold text-[#40233f]"
          >
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  )
}

function humanize(s: string): string {
  return s.replace(/_/g, ' ')
}

function formatAddress(
  addr:
    | {
        line1: string
        line2: string | null
        city: string
        state: string
        zip: string
      }
    | null
    | undefined
): string | null {
  if (!addr) return null
  const cityState = [addr.city, addr.state].filter(Boolean).join(', ')
  return [addr.line1, cityState].filter(Boolean).join(', ')
}

function severityTone(severity: string): ChipTone {
  const s = severity.toLowerCase()
  if (s === 'block' || s === 'error' || s === 'critical') return 'red'
  if (s === 'warn' || s === 'warning') return 'orange'
  if (s === 'ok' || s === 'info' || s === 'pass') return 'green'
  return 'neutral'
}

function fileStatusTone(status: string): ChipTone {
  const s = status.toLowerCase()
  if (s === 'closed' || s === 'completed' || s === 'done') return 'green'
  if (s === 'blocked' || s === 'cancelled' || s === 'on_hold') return 'red'
  if (s === 'pending' || s === 'in_progress' || s === 'open') return 'violet'
  return 'neutral'
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

type NotificationGroup = {
  groupKey: string
  kind: string
  fileId: string | null
  headline: NotificationRow
  memberIds: string[]
  count: number
  latestAt: number
  unread: number
  blockers: number
  warnings: number
}

type UnreadSummary = {
  total: number
  blockers: number
  warnings: number
  groups: number
}

function NotificationsBell() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set()
  )
  const navigate = useNavigate()

  // Skip when there's no active tenant — both queries require one.
  const tenant = useQuery({
    ...convexQuery(api.tenants.current, {}),
    retry: false,
  })
  const hasTenant = !!tenant.data && !tenant.error

  const grouped = useQuery({
    ...convexQuery(api.notifications.groupedForMe, { limit: 80 }),
    enabled: hasTenant,
    retry: false,
  })
  const summaryQ = useQuery({
    ...convexQuery(api.notifications.unreadSummary, {}),
    enabled: hasTenant,
    retry: false,
  })
  const list = useQuery({
    ...convexQuery(api.notifications.listForMe, { limit: 80 }),
    enabled: hasTenant && open,
    retry: false,
  })
  const markRead = useConvexMutation(api.notifications.markRead)
  const markAllRead = useConvexMutation(api.notifications.markAllRead)
  const markGroupRead = useConvexMutation(api.notifications.markGroupRead)
  const dismissGroup = useConvexMutation(api.notifications.dismissGroup)
  const dismissAll = useConvexMutation(api.notifications.dismissAll)

  const groups = (grouped.data ?? []) as ReadonlyArray<NotificationGroup>
  const summary = (summaryQ.data ?? {
    total: 0,
    blockers: 0,
    warnings: 0,
    groups: 0,
  }) as UnreadSummary
  const allRows = (list.data ?? []) as ReadonlyArray<NotificationRow>
  const rowsByGroup = useMemo(() => {
    const m = new Map<string, NotificationRow[]>()
    for (const r of allRows) {
      const key =
        (r as NotificationRow & { groupKey?: string | null }).groupKey ?? r.kind
      const arr = m.get(key) ?? []
      arr.push(r)
      m.set(key, arr)
    }
    return m
  }, [allRows])

  // Outside-click to dismiss.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    return () => document.removeEventListener('mousedown', onPointer)
  }, [open])

  useEffect(() => {
    if (!open) {
      setConfirmingClear(false)
      setExpandedGroups(new Set())
    }
  }, [open])

  // Ring the bell when blockers exist on first paint, and again whenever
  // the count strictly increases. Linear easing + decaying amplitude reads
  // like real bell physics — one strike, multiple oscillations that settle.
  // Hooks run unconditionally — must live above the `!hasTenant` early return.
  const [bellScope, animateBell] = useAnimate<HTMLSpanElement>()
  const previousBlockers = useRef<number | null>(null)
  useEffect(() => {
    if (summaryQ.data === undefined) return
    const next = summaryQ.data.blockers
    const prev = previousBlockers.current
    const isFirstPaint = prev === null
    previousBlockers.current = next
    if (next === 0) return
    if (!isFirstPaint && next <= prev) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return

    // Settle delay on first paint so the bell rings AFTER the page has
    // finished arriving — otherwise the user is still parsing the layout
    // and the ring goes unnoticed.
    const settle = isFirstPaint ? 450 : 0
    const id = window.setTimeout(() => {
      if (!bellScope.current) return
      animateBell(
        bellScope.current,
        {
          transform: [
            'rotate(0deg) scale(1)',
            'rotate(-26deg) scale(1.1)',
            'rotate(22deg) scale(1.06)',
            'rotate(-16deg) scale(1.04)',
            'rotate(11deg) scale(1.02)',
            'rotate(-7deg) scale(1.01)',
            'rotate(4deg) scale(1)',
            'rotate(-2deg) scale(1)',
            'rotate(0deg) scale(1)',
          ],
        },
        { duration: 1.1, ease: 'linear' },
      )
    }, settle)
    return () => window.clearTimeout(id)
  }, [summaryQ.data?.blockers, animateBell, bellScope])

  if (!hasTenant) return null

  const onHeadlineClick = async (g: NotificationGroup) => {
    // Navigating closes the bell; marking the group read happens regardless.
    setOpen(false)
    if (g.unread > 0) {
      try {
        await markGroupRead({ groupKey: g.groupKey })
      } catch {
        /* observability, not correctness */
      }
    }
    if (g.fileId) {
      navigate({ to: '/files/$fileId', params: { fileId: g.fileId } })
    }
  }

  const onToggleGroup = (g: NotificationGroup) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(g.groupKey)) next.delete(g.groupKey)
      else next.add(g.groupKey)
      return next
    })
  }

  const onDismissGroup = async (g: NotificationGroup) => {
    try {
      await dismissGroup({ groupKey: g.groupKey })
    } catch {
      /* ignore */
    }
  }

  const onMemberClick = async (n: NotificationRow) => {
    setOpen(false)
    if (!n.readAt) {
      try {
        await markRead({ notificationId: n._id as Id<'notifications'> })
      } catch {
        /* ignore */
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

  // Pick the badge color and number based on severity. Blockers are the
  // primary signal — they get the red badge alone. Warnings + info accrue
  // a secondary muted count so a noisy "2 extractions done" stream doesn't
  // visually compete with a real fire.
  const blockerCount = summary.blockers
  const nonBlockerUnread = Math.max(0, summary.total - summary.blockers)
  const totalGroups = groups.length

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={
          blockerCount > 0
            ? `Notifications, ${blockerCount} blocker${blockerCount === 1 ? '' : 's'}`
            : summary.total > 0
              ? `Notifications, ${summary.total} unread`
              : 'Notifications'
        }
        aria-expanded={open}
        className={`relative inline-flex size-9 items-center justify-center rounded-xl border border-input bg-card text-[#40233f] transition-[background-color,transform,box-shadow] duration-[160ms] ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-[#fdf6e8] active:scale-[0.94] ${
          open ? 'ring-2 ring-[#593157]/30' : ''
        }`}
      >
        <span
          ref={bellScope}
          className="inline-flex"
          style={{ transformOrigin: '50% 12%' }}
        >
          <Bell className="size-4" />
        </span>
        <AnimatePresence mode="popLayout" initial={false}>
          {blockerCount > 0 ? (
            <motion.span
              key={`blocker-${blockerCount}`}
              initial={{ transform: 'scale(0.5)', opacity: 0 }}
              animate={{ transform: 'scale(1)', opacity: 1 }}
              exit={{ transform: 'scale(0.5)', opacity: 0 }}
              transition={{ type: 'spring', duration: 0.45, bounce: 0.35 }}
              className="absolute -top-1.5 -right-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#b94f58] px-1 text-[10px] leading-none font-semibold text-white ring-2 ring-background"
            >
              {blockerCount > 99 ? '99+' : blockerCount}
            </motion.span>
          ) : nonBlockerUnread > 0 ? (
            <motion.span
              key={`unread-${nonBlockerUnread}`}
              initial={{ transform: 'scale(0.5)', opacity: 0 }}
              animate={{ transform: 'scale(1)', opacity: 1 }}
              exit={{ transform: 'scale(0.5)', opacity: 0 }}
              transition={{ type: 'spring', duration: 0.4, bounce: 0.25 }}
              className="absolute -top-1.5 -right-1.5 inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-[#7a5818] px-1 text-[10px] leading-none font-semibold text-white ring-2 ring-background"
            >
              {nonBlockerUnread > 99 ? '99+' : nonBlockerUnread}
            </motion.span>
          ) : null}
        </AnimatePresence>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute top-full right-0 z-50 mt-2 w-[24rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border/70 bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/5"
        >
          <header className="flex items-center justify-between gap-3 border-b border-border/60 bg-[#fdf6e8]/60 px-4 py-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-[#b78625]">
                Notifications
              </div>
              <div className="font-display text-base leading-none font-semibold tracking-tight text-[#40233f]">
                {blockerCount > 0
                  ? `${blockerCount} blocker${blockerCount === 1 ? '' : 's'}`
                  : summary.total > 0
                    ? `${summary.total} unread`
                    : "You're all caught up"}
              </div>
              {summary.total > 0 && (
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {summary.groups === 1
                    ? 'on 1 thread'
                    : `across ${summary.groups} threads`}
                  {summary.warnings > 0 && (
                    <span className="ml-1 text-[#7a3d18]">
                      · {summary.warnings} warning{summary.warnings === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
              )}
            </div>
            {totalGroups > 0 && (
              <div className="flex shrink-0 items-center gap-1">
                {!confirmingClear && summary.total > 0 && (
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
                      Clear all
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
            {grouped.isLoading && !grouped.data ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                Loading...
              </div>
            ) : groups.length === 0 ? (
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
              <ol className="space-y-1.5 p-2">
                {groups.map((g) => (
                  <NotificationGroupView
                    key={g.groupKey}
                    group={g}
                    members={rowsByGroup.get(g.groupKey) ?? []}
                    expanded={expandedGroups.has(g.groupKey)}
                    onHeadlineClick={() => onHeadlineClick(g)}
                    onToggle={() => onToggleGroup(g)}
                    onDismiss={() => onDismissGroup(g)}
                    onMemberClick={onMemberClick}
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

function NotificationGroupView({
  group,
  members,
  expanded,
  onHeadlineClick,
  onToggle,
  onDismiss,
  onMemberClick,
}: {
  group: NotificationGroup
  members: ReadonlyArray<NotificationRow>
  expanded: boolean
  onHeadlineClick: () => void
  onToggle: () => void
  onDismiss: () => void
  onMemberClick: (n: NotificationRow) => void
}) {
  const sev = group.headline.severity ?? null
  const tone =
    group.blockers > 0 || sev === 'block'
      ? {
          dot: 'bg-[#b94f58]',
          chip: 'bg-[#fdecee] text-[#8a3942]',
        }
      : group.warnings > 0 || sev === 'warn'
        ? {
            dot: 'bg-[#c9652e]',
            chip: 'bg-[#fde9dc] text-[#7a3d18]',
          }
        : sev === 'ok'
          ? {
              dot: 'bg-[#3f7c64]',
              chip: 'bg-[#e6f3ed] text-[#2f5d4b]',
            }
          : {
              dot: 'bg-muted-foreground/40',
              chip: 'bg-muted text-muted-foreground',
            }

  const isThread = group.count > 1
  const cardBg = group.unread > 0 ? 'bg-[#fdf6e8]/40' : 'bg-card'

  return (
    <li
      className={`overflow-hidden rounded-lg border border-border/50 ${cardBg}`}
    >
      <NotificationRowView
        n={group.headline}
        onClick={onHeadlineClick}
        threadCount={isThread ? group.count : undefined}
        leadingDot={
          group.unread > 0 ? (
            <span
              aria-label="Unread"
              className={`size-1.5 rounded-full ${tone.dot}`}
            />
          ) : undefined
        }
      />
      {expanded && isThread && members.length > 1 && (
        <div className="relative border-t border-border/40 bg-muted/20">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-0 bottom-0 left-[22px] w-px bg-border/60"
          />
          <ol>
            {members
              .filter((m) => m._id !== group.headline._id)
              .map((m) => (
                <NotificationRowView
                  key={m._id}
                  n={m}
                  onClick={() => onMemberClick(m)}
                  compact
                />
              ))}
          </ol>
        </div>
      )}
      {isThread && (
        <div className="flex items-center justify-between gap-2 border-t border-border/40 bg-muted/30 px-3 py-1.5">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition hover:opacity-80 ${tone.chip}`}
          >
            {expanded
              ? 'Hide thread'
              : `Show ${group.count - 1} more`}
            {!expanded && group.unread > 0
              ? ` · ${group.unread} unread`
              : ''}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-full px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition hover:bg-card hover:text-[#8a3942]"
            title="Clear this thread"
          >
            Clear thread
          </button>
        </div>
      )}
    </li>
  )
}

function NotificationRowView({
  n,
  onClick,
  leadingDot,
  compact = false,
  threadCount,
}: {
  n: NotificationRow
  onClick: () => void
  leadingDot?: React.ReactNode
  compact?: boolean
  threadCount?: number
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
      className={`group/notif flex w-full cursor-pointer items-start gap-3 text-left transition hover:bg-[#fdf6e8]/50 focus:outline-none focus-visible:bg-[#fdf6e8]/60 ${
        compact ? 'px-3 py-1.5' : 'px-4 py-2.5'
      } ${unread ? 'bg-[#fdf6e8]/30' : ''}`}
    >
      {leadingDot && (
        <span className="mt-2 inline-flex shrink-0">{leadingDot}</span>
      )}
      <div className="relative mt-0.5 shrink-0">
        <div
          className={`grid place-items-center rounded-full ring-1 ring-inset ${tone.bg} ${tone.text} ${
            compact ? 'size-5' : 'size-6'
          }`}
        >
          {tone.icon}
        </div>
        {threadCount && threadCount > 1 ? (
          <span
            aria-label={`${threadCount} in thread`}
            className="absolute -right-1.5 -bottom-1 inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-[#40233f] px-1 text-[9px] font-bold leading-none text-white ring-2 ring-card"
          >
            {threadCount > 99 ? '99+' : threadCount}
          </span>
        ) : null}
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
          {unread && !leadingDot && (
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
