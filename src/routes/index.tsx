import { createFileRoute, Link, useRouter } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { convexQuery } from "@convex-dev/react-query"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { AppShell } from "@/components/app-shell"
import { api } from "../../convex/_generated/api"

export const Route = createFileRoute("/")({ component: App })

function App() {
  const router = useRouter()
  const { isAuthenticated } = router.options.context as {
    isAuthenticated?: boolean
  }

  if (!isAuthenticated) return <MarketingHome />
  return <Dashboard />
}

function MarketingHome() {
  return (
    <AppShell
      isAuthenticated={false}
      title="Title Hub"
      subtitle="Multi-tenant operations platform for title agencies."
    >
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>Sign in to continue</CardTitle>
          <CardDescription>
            Pilot environment. Reach out for an invitation if you don't have
            one.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button asChild>
            <Link to="/signin">Sign in</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/signin" search={{ mode: "sign-up" }}>
              Create account
            </Link>
          </Button>
        </CardContent>
      </Card>
    </AppShell>
  )
}

function Dashboard() {
  const current = useQuery(convexQuery(api.tenants.current, {}))
  const files = useQuery(convexQuery(api.files.list, {}))

  if (current.error) {
    const msg = current.error.message
    if (/NO_ACTIVE_TENANT|NOT_A_MEMBER|TENANT_NOT_FOUND/.test(msg)) {
      return (
        <AppShell
          isAuthenticated
          title="Welcome"
          subtitle="Pick or create your organization to continue."
        >
          <Card className="mx-auto max-w-xl">
            <CardHeader>
              <CardTitle>No active organization</CardTitle>
              <CardDescription>
                You need to choose or create one before opening files.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild>
                <Link to="/tenants">Go to organizations</Link>
              </Button>
            </CardContent>
          </Card>
        </AppShell>
      )
    }
    return (
      <AppShell isAuthenticated title="Dashboard">
        <div className="text-destructive text-sm">Error: {msg}</div>
      </AppShell>
    )
  }

  const subtitle = current.data
    ? `${current.data.legalName} · ${current.data.role}`
    : "Loading..."

  return (
    <AppShell
      isAuthenticated
      title="Dashboard"
      subtitle={subtitle}
      actions={
        <Button asChild>
          <Link to="/files">Open files</Link>
        </Button>
      }
    >
      <DashboardContent files={files.data ?? []} />
    </AppShell>
  )
}

function DashboardContent({
  files,
}: {
  files: ReadonlyArray<{
    _id: string
    fileNumber: string
    transactionType: string
    stateCode: string
    status: string
    openedAt: number
    targetCloseDate?: number
  }>
}) {
  const open = files.filter((f) => f.status !== "policied" && f.status !== "cancelled")
  const closingSoon = open
    .filter((f) => f.targetCloseDate && f.targetCloseDate < Date.now() + 7 * 24 * 3600 * 1000)
    .slice(0, 5)

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Active files" value={String(open.length)} accent="primary" />
        <KpiCard
          label="Total files"
          value={String(files.length)}
          accent="info"
        />
        <KpiCard
          label="Closing in 7 days"
          value={String(closingSoon.length)}
          accent="warn"
        />
        <KpiCard
          label="Cancelled"
          value={String(files.filter((f) => f.status === "cancelled").length)}
          accent="muted"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-baseline justify-between">
            <div>
              <CardTitle>Recent files</CardTitle>
              <CardDescription>
                Newest first. Open one to view findings, parties, and rules.
              </CardDescription>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link to="/files">All files</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {open.length === 0 ? (
              <p className="text-muted-foreground text-sm">No active files.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {open.slice(0, 6).map((f) => (
                  <li key={f._id}>
                    <Link
                      to="/files/$fileId"
                      params={{ fileId: f._id }}
                      className="hover:bg-muted/60 flex items-center justify-between rounded-lg border border-border/60 px-3 py-2 text-sm transition"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{f.fileNumber}</div>
                        <div className="text-muted-foreground text-xs">
                          {f.transactionType} · {f.stateCode} ·{" "}
                          {new Date(f.openedAt).toLocaleDateString()}
                        </div>
                      </div>
                      <StatusBadge status={f.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Closing this week</CardTitle>
            <CardDescription>Files with target close inside 7 days.</CardDescription>
          </CardHeader>
          <CardContent>
            {closingSoon.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nothing on the calendar.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {closingSoon.map((f) => (
                  <li
                    key={f._id}
                    className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2 text-sm"
                  >
                    <ClosingBadge timestamp={f.targetCloseDate!} />
                    <div className="min-w-0 flex-1">
                      <Link
                        to="/files/$fileId"
                        params={{ fileId: f._id }}
                        className="block truncate font-medium hover:underline"
                      >
                        {f.fileNumber}
                      </Link>
                      <div className="text-muted-foreground text-xs">
                        {f.transactionType}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Separator />
      <div className="text-muted-foreground text-xs">
        Sprint 4 wedge active — drop a purchase agreement and counter offer on a
        file, run "Reconcile", and see findings within seconds.
      </div>
    </div>
  )
}

function KpiCard({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent: "primary" | "info" | "warn" | "muted"
}) {
  const color =
    accent === "primary"
      ? "text-[#40233f]"
      : accent === "warn"
        ? "text-[#c9652e]"
        : accent === "info"
          ? "text-[#3f668f]"
          : "text-muted-foreground"
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="text-[10px] uppercase tracking-[0.16em]">
          {label}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className={`font-serif text-3xl font-semibold ${color}`}>
          {value}
        </div>
      </CardContent>
    </Card>
  )
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "opened" || status === "in_exam"
      ? "secondary"
      : status === "cleared" || status === "closing"
        ? "default"
        : status === "cancelled"
          ? "destructive"
          : "outline"
  return (
    <Badge variant={tone} className="text-[10px] uppercase tracking-wide">
      {status}
    </Badge>
  )
}

function ClosingBadge({ timestamp }: { timestamp: number }) {
  const d = new Date(timestamp)
  return (
    <div className="bg-muted text-foreground/80 grid w-12 shrink-0 place-items-center rounded-lg border border-border/60 py-1">
      <div className="font-serif text-xl leading-none text-[#40233f]">
        {d.getDate()}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {d.toLocaleString("en-US", { month: "short" })}
      </div>
    </div>
  )
}
