import { Link, useNavigate, useRouter } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { convexQuery } from "@convex-dev/react-query"
import { Search, Plus, LogOut } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { authClient } from "@/lib/auth-client"
import { AppSidebar } from "./app-sidebar"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"

type AppShellProps = {
  isAuthenticated: boolean
  title: string
  subtitle?: string
  actions?: React.ReactNode
  children: React.ReactNode
}

export function AppShell({
  isAuthenticated,
  title,
  subtitle,
  actions,
  children,
}: AppShellProps) {
  const router = useRouter()
  const [signingOut, setSigningOut] = useState(false)

  const onSignOut = async () => {
    setSigningOut(true)
    try {
      await authClient.signOut()
      router.navigate({ to: "/signin" })
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <SidebarProvider>
      {isAuthenticated && <AppSidebar isAuthenticated={isAuthenticated} />}
      <SidebarInset className="bg-background">
        <header className="sticky top-0 z-10 flex flex-col gap-4 border-b border-border/60 bg-background/85 px-4 py-4 backdrop-blur lg:px-8">
          <div className="flex items-start gap-4">
            {isAuthenticated && (
              <SidebarTrigger className="mt-1 -ml-1 lg:hidden" />
            )}
            <div className="min-w-0 flex-1">
              <h1 className="truncate font-serif text-2xl font-semibold tracking-tight text-[#40233f] sm:text-3xl">
                {title}
              </h1>
              {subtitle && (
                <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {actions}
              {isAuthenticated && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onSignOut}
                  disabled={signingOut}
                >
                  <LogOut className="size-4" />
                  <span className="hidden sm:inline">Sign out</span>
                </Button>
              )}
            </div>
          </div>

          {isAuthenticated && (
            <div className="flex items-center gap-3">
              <GlobalSearch />
              <Button asChild>
                <Link to="/files" search={{ new: true }}>
                  <Plus className="size-4" />
                  New file
                </Link>
              </Button>
            </div>
          )}
        </header>

        <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 lg:px-8">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}

function GlobalSearch() {
  const navigate = useNavigate()
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState("")
  const [open, setOpen] = useState(false)
  const trimmed = q.trim()
  const enabled = trimmed.length >= 2

  const results = useQuery({
    ...convexQuery(api.search.global, { q: trimmed }),
    enabled,
  })

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onPointer)
    return () => document.removeEventListener("mousedown", onPointer)
  }, [open])

  const close = () => {
    setOpen(false)
    setQ("")
  }
  const gotoFile = (fileId: Id<"files">) => {
    close()
    navigate({ to: "/files/$fileId", params: { fileId } })
  }

  const data = results.data
  const showPanel = open && enabled
  const isEmpty =
    showPanel &&
    !!data &&
    data.files.length === 0 &&
    data.parties.length === 0 &&
    data.findings.length === 0

  return (
    <div
      ref={containerRef}
      className="relative flex flex-1 items-center gap-2 rounded-xl border border-input bg-card px-3 py-2 shadow-xs"
    >
      <Search className="size-4 shrink-0 text-muted-foreground" />
      <Input
        ref={inputRef}
        className="border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
        placeholder="Search file number, party, finding..."
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
        onFocus={() => {
          if (trimmed.length >= 2) setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false)
            inputRef.current?.blur()
          }
        }}
      />
      {showPanel && (
        <div className="bg-popover text-popover-foreground absolute left-0 right-0 top-full z-50 mt-2 max-h-[60vh] overflow-y-auto rounded-2xl p-2 shadow-lg ring-1 ring-foreground/5">
          {results.isLoading && !data && (
            <div className="text-muted-foreground px-3 py-4 text-sm">
              Searching...
            </div>
          )}
          {isEmpty && (
            <div className="text-muted-foreground px-3 py-4 text-sm">
              No matches for "{trimmed}".
            </div>
          )}
          {data && (
            <div className="flex flex-col gap-1">
              {data.files.length > 0 && (
                <ResultGroup label="Files">
                  {data.files.map((f) => (
                    <ResultRow
                      key={f._id}
                      title={f.fileNumber}
                      meta={`${f.transactionType} · ${f.status}`}
                      onSelect={() => gotoFile(f._id as Id<"files">)}
                    />
                  ))}
                </ResultGroup>
              )}
              {data.parties.length > 0 && (
                <ResultGroup label="Parties">
                  {data.parties.map((p) => (
                    <ResultRow
                      key={p.partyId}
                      title={p.legalName}
                      meta={
                        p.fileNumber
                          ? `${p.partyType} · on ${p.fileNumber}`
                          : `${p.partyType} · unattached`
                      }
                      disabled={!p.fileId}
                      onSelect={() =>
                        p.fileId && gotoFile(p.fileId as Id<"files">)
                      }
                    />
                  ))}
                </ResultGroup>
              )}
              {data.findings.length > 0 && (
                <ResultGroup label="Findings">
                  {data.findings.map((fd) => (
                    <ResultRow
                      key={fd.findingId}
                      title={fd.message}
                      meta={`${fd.severity} · ${fd.findingType}${fd.fileNumber ? ` · ${fd.fileNumber}` : ""}`}
                      onSelect={() => gotoFile(fd.fileId as Id<"files">)}
                    />
                  ))}
                </ResultGroup>
              )}
            </div>
          )}
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
      <div className="text-muted-foreground px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide">
        {label}
      </div>
      {children}
    </div>
  )
}

function ResultRow({
  title,
  meta,
  onSelect,
  disabled,
}: {
  title: string
  meta?: string
  onSelect: () => void
  disabled?: boolean
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      disabled={disabled}
      onClick={onSelect}
      className="hover:bg-muted h-auto w-full flex-col items-start gap-0.5 whitespace-normal rounded-xl px-3 py-2 text-left text-sm font-normal"
    >
      <span className="line-clamp-1 w-full font-medium">{title}</span>
      {meta && (
        <span className="text-muted-foreground w-full text-xs">{meta}</span>
      )}
    </Button>
  )
}
