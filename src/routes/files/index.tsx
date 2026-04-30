import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { convexQuery, useConvexMutation } from "@convex-dev/react-query"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { AppShell } from "@/components/app-shell"
import { CountyCombobox } from "@/components/county-combobox"
import { api } from "../../../convex/_generated/api"
import type { Id } from "../../../convex/_generated/dataModel"

type FilesSearch = { new?: boolean }

export const Route = createFileRoute("/files/")({
  beforeLoad: ({ context }) => {
    if (!(context as { isAuthenticated?: boolean }).isAuthenticated) {
      throw redirect({ to: "/signin" })
    }
  },
  validateSearch: (raw): FilesSearch => {
    const v = (raw as Record<string, unknown>).new
    const isNew =
      v === true || v === "true" || v === 1 || v === "1"
    return { new: isNew || undefined }
  },
  component: FilesListPage,
})

function FilesListPage() {
  const search = Route.useSearch() as FilesSearch
  const navigate = useNavigate()
  const current = useQuery(convexQuery(api.tenants.current, {}))
  const list = useQuery(convexQuery(api.files.list, {}))
  const counties = useQuery(convexQuery(api.seed.listIndianaCounties, {}))
  const create = useConvexMutation(api.files.create)
  const seedIndiana = useConvexMutation(api.seed.indiana)

  const [showForm, setShowForm] = useState(search.new === true)

  useEffect(() => {
    if (search.new === true) {
      setShowForm(true)
      navigate({ to: "/files", search: {}, replace: true })
    }
  }, [search.new, navigate])
  const [fileNumber, setFileNumber] = useState("")
  const [countyId, setCountyId] = useState<Id<"counties"> | "">("")
  const [transactionType, setTransactionType] = useState("purchase")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  if (current.error) {
    const msg = current.error.message
    if (/NO_ACTIVE_TENANT|NOT_A_MEMBER|TENANT_NOT_FOUND/.test(msg)) {
      return (
        <AppShell isAuthenticated title="Files">
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
      <AppShell isAuthenticated title="Files">
        <p className="text-destructive text-sm">Error: {msg}</p>
      </AppShell>
    )
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!countyId) {
      setError("Pick a county.")
      return
    }
    setPending(true)
    setError(null)
    try {
      await create({
        fileNumber: fileNumber.trim(),
        countyId: countyId as Id<"counties">,
        transactionType,
      })
      setShowForm(false)
      setFileNumber("")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg.replace(/^.*ConvexError:\s*/, ""))
    } finally {
      setPending(false)
    }
  }

  const seedIfEmpty = async () => {
    await seedIndiana({})
  }

  const files = list.data ?? []
  const countyOptions = counties.data ?? []

  return (
    <AppShell
      isAuthenticated
      title="Files"
      subtitle={
        current.data
          ? `${current.data.legalName} · ${current.data.role}`
          : undefined
      }
      actions={
        <>
          {countyOptions.length === 0 && (
            <Button variant="outline" size="sm" onClick={seedIfEmpty}>
              Seed Indiana counties
            </Button>
          )}
          <Button onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Cancel" : "New file"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {showForm && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Create a file</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={onSubmit} className="flex flex-col gap-3">
                <Input
                  placeholder="File number (e.g. QT-2026-0001)"
                  value={fileNumber}
                  onChange={(e) => setFileNumber(e.target.value)}
                  required
                />
                <CountyCombobox
                  counties={countyOptions}
                  value={countyId}
                  onChange={setCountyId}
                />
                <Select
                  value={transactionType}
                  onValueChange={setTransactionType}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="purchase">Purchase</SelectItem>
                    <SelectItem value="refi">Refinance</SelectItem>
                    <SelectItem value="commercial">Commercial</SelectItem>
                    <SelectItem value="reo">REO</SelectItem>
                  </SelectContent>
                </Select>
                {error && (
                  <p className="text-destructive text-sm">{error}</p>
                )}
                <Button type="submit" disabled={pending}>
                  {pending ? "Creating..." : "Create file"}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {list.isLoading ? (
          <p className="text-muted-foreground text-sm">Loading...</p>
        ) : files.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground py-12 text-center text-sm">
              No files yet. Click <strong>New file</strong> to create one.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Open files</CardTitle>
              <CardDescription>
                Click a row to open the file detail.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {files.map((f) => (
                <Link
                  key={f._id}
                  to="/files/$fileId"
                  params={{ fileId: f._id }}
                  className="hover:bg-muted/60 flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2 text-sm transition"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{f.fileNumber}</div>
                    <div className="text-muted-foreground text-xs">
                      {f.transactionType} · {f.stateCode} · opened{" "}
                      {new Date(f.openedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <Badge
                    variant={
                      f.status === "opened" || f.status === "in_exam"
                        ? "secondary"
                        : f.status === "cancelled"
                          ? "destructive"
                          : "default"
                    }
                    className="text-[10px] uppercase tracking-wide"
                  >
                    {f.status}
                  </Badge>
                </Link>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  )
}
