import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { convexQuery, useConvexMutation } from "@convex-dev/react-query"
import { Button } from "@/components/ui/button"
import { api } from "../../../convex/_generated/api"
import type { Id } from "../../../convex/_generated/dataModel"

export const Route = createFileRoute("/files/")({
  beforeLoad: ({ context }) => {
    if (!(context as { isAuthenticated?: boolean }).isAuthenticated) {
      throw redirect({ to: "/signin" })
    }
  },
  component: FilesListPage,
})

function FilesListPage() {
  const current = useQuery(convexQuery(api.tenants.current, {}))
  const list = useQuery(convexQuery(api.files.list, {}))
  const counties = useQuery(convexQuery(api.seed.listIndianaCounties, {}))
  const create = useConvexMutation(api.files.create)
  const seedIndiana = useConvexMutation(api.seed.indiana)

  const [showForm, setShowForm] = useState(false)
  const [fileNumber, setFileNumber] = useState("")
  const [countyId, setCountyId] = useState<Id<"counties"> | "">("")
  const [transactionType, setTransactionType] = useState("purchase")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  if (current.error) {
    const msg = current.error.message
    if (/NO_ACTIVE_TENANT|NOT_A_MEMBER|TENANT_NOT_FOUND/.test(msg)) {
      return (
        <div className="flex min-h-svh flex-col items-center justify-center gap-3 p-6">
          <p>You don&apos;t have an active organization yet.</p>
          <Link to="/tenants" className="underline">
            Choose or create one
          </Link>
        </div>
      )
    }
    return <div className="p-6 text-sm text-red-600">Error: {msg}</div>
  }

  if (current.isLoading || list.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>
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
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <div className="text-muted-foreground text-xs uppercase tracking-wide">
            {current.data?.legalName} · {current.data?.role}
          </div>
          <h1 className="text-xl font-semibold">Files</h1>
        </div>
        <div className="flex gap-2">
          {countyOptions.length === 0 && (
            <Button variant="outline" onClick={seedIfEmpty}>
              Seed Indiana counties
            </Button>
          )}
          <Button onClick={() => setShowForm(!showForm)}>
            {showForm ? "Cancel" : "New file"}
          </Button>
        </div>
      </header>

      {showForm && (
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-2 rounded-md border p-4"
        >
          <input
            className="rounded border px-3 py-2 text-sm"
            placeholder="File number (e.g. QT-2026-0001)"
            value={fileNumber}
            onChange={(e) => setFileNumber(e.target.value)}
            required
          />
          <select
            className="rounded border px-3 py-2 text-sm"
            value={countyId}
            onChange={(e) => setCountyId(e.target.value as Id<"counties">)}
            required
          >
            <option value="">Select county...</option>
            {countyOptions.map((c) => (
              <option key={c._id} value={c._id}>
                {c.name} County, {c.stateCode}
              </option>
            ))}
          </select>
          <select
            className="rounded border px-3 py-2 text-sm"
            value={transactionType}
            onChange={(e) => setTransactionType(e.target.value)}
          >
            <option value="purchase">Purchase</option>
            <option value="refi">Refinance</option>
            <option value="commercial">Commercial</option>
            <option value="reo">REO</option>
          </select>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" disabled={pending}>
            {pending ? "Creating..." : "Create file"}
          </Button>
        </form>
      )}

      {files.length === 0 ? (
        <div className="rounded-md border p-6 text-sm text-muted-foreground">
          No files yet.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {files.map((f) => (
            <li key={f._id} className="rounded-md border p-3">
              <Link
                to="/files/$fileId"
                params={{ fileId: f._id }}
                className="flex items-center justify-between gap-3"
              >
                <div>
                  <div className="font-medium">{f.fileNumber}</div>
                  <div className="text-muted-foreground text-xs">
                    {f.transactionType} · {f.stateCode} ·{" "}
                    {new Date(f.openedAt).toLocaleDateString()}
                  </div>
                </div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {f.status}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
