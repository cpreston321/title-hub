import { createFileRoute, redirect, useRouter } from "@tanstack/react-router"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { convexQuery, useConvexMutation } from "@convex-dev/react-query"
import { Button } from "@/components/ui/button"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"

export const Route = createFileRoute("/tenants")({
  beforeLoad: ({ context }) => {
    if (!(context as { isAuthenticated?: boolean }).isAuthenticated) {
      throw redirect({ to: "/signin" })
    }
  },
  component: TenantsPage,
})

function TenantsPage() {
  const router = useRouter()
  const memberships = useQuery(convexQuery(api.tenants.listMine, {}))
  const setActive = useConvexMutation(api.tenants.setActive)
  const create = useConvexMutation(api.tenants.create)

  const [slug, setSlug] = useState("")
  const [legalName, setLegalName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const onPick = async (tenantId: Id<"tenants">) => {
    await setActive({ tenantId })
    router.navigate({ to: "/files" })
  }

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      await create({ slug, legalName })
      router.navigate({ to: "/files" })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg.replace(/^.*ConvexError:\s*/, ""))
    } finally {
      setPending(false)
    }
  }

  const list = memberships.data?.memberships ?? []

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-xl flex-col gap-8 p-6">
      <header>
        <h1 className="text-xl font-semibold">Choose an organization</h1>
        <p className="text-sm text-muted-foreground">
          Pick an existing organization or create a new one.
        </p>
      </header>

      {list.length > 0 && (
        <ul className="flex flex-col gap-2">
          {list.map((m) => (
            <li
              key={m.tenantId}
              className="flex items-center justify-between rounded-md border p-3"
            >
              <div>
                <div className="font-medium">{m.legalName}</div>
                <div className="text-xs text-muted-foreground">
                  {m.slug} · {m.role}
                </div>
              </div>
              <Button onClick={() => onPick(m.tenantId)}>Open</Button>
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={onCreate}
        className="flex flex-col gap-3 rounded-md border p-4"
      >
        <h2 className="text-sm font-medium">Create a new organization</h2>
        <input
          className="rounded border px-3 py-2 text-sm"
          placeholder="Slug (e.g. quality-title)"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          required
          pattern="[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?"
        />
        <input
          className="rounded border px-3 py-2 text-sm"
          placeholder="Legal name (e.g. Quality Title Insurance LLC)"
          value={legalName}
          onChange={(e) => setLegalName(e.target.value)}
          required
          minLength={2}
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button type="submit" disabled={pending}>
          {pending ? "Creating..." : "Create"}
        </Button>
      </form>
    </div>
  )
}
