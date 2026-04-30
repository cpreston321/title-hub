import { Link, useRouter } from "@tanstack/react-router"
import { Search, Plus, LogOut } from "lucide-react"
import { useState } from "react"

import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { authClient } from "@/lib/auth-client"
import { AppSidebar } from "./app-sidebar"

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
        <header className="bg-background/85 sticky top-0 z-10 flex flex-col gap-4 border-b border-border/60 px-4 py-4 backdrop-blur lg:px-8">
          <div className="flex items-start gap-4">
            {isAuthenticated && (
              <SidebarTrigger className="mt-1 -ml-1 lg:hidden" />
            )}
            <div className="min-w-0 flex-1">
              <h1 className="truncate font-serif text-2xl font-semibold tracking-tight text-[#40233f] sm:text-3xl">
                {title}
              </h1>
              {subtitle && (
                <p className="text-muted-foreground mt-1 text-sm">{subtitle}</p>
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
              <div className="bg-card border-input shadow-xs flex flex-1 items-center gap-2 rounded-2xl border px-3 py-2">
                <Search className="text-muted-foreground size-4 shrink-0" />
                <Input
                  className="border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
                  placeholder="Search address, county, buyer, examiner, finding..."
                />
              </div>
              <Button asChild>
                <Link to="/files">
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

        <footer className="bg-[#40233f] text-white/80">
          <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-3 px-4 py-3 text-xs lg:px-8">
            <StatusPill tone="ok" label="Convex live" />
            <StatusPill tone="ok" label="Better Auth orgs" />
            <StatusPill tone="ok" label="NPI tokenization (mock CMK)" />
            <Separator
              orientation="vertical"
              className="h-4 bg-white/10"
            />
            <span>v0.5 — sprints 0-5</span>
          </div>
        </footer>
      </SidebarInset>
    </SidebarProvider>
  )
}

function StatusPill({
  tone,
  label,
}: {
  tone: "ok" | "warn" | "off"
  label: string
}) {
  const dot =
    tone === "ok"
      ? "bg-[#7db397]"
      : tone === "warn"
        ? "bg-[#ebb18a]"
        : "bg-[#d27f87]"
  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-white/5 px-3 py-1">
      <span className={`size-2 rounded-full ${dot}`} />
      {label}
    </span>
  )
}
