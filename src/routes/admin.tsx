import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { convexQuery } from "@convex-dev/react-query"
import { api } from "../../convex/_generated/api"

export const Route = createFileRoute("/admin")({
  beforeLoad: ({ context }) => {
    if (!(context as { isAuthenticated?: boolean }).isAuthenticated) {
      throw redirect({ to: "/signin" })
    }
  },
  component: AdminPage,
})

function AdminPage() {
  const current = useQuery(convexQuery(api.tenants.current, {}))

  if (current.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>
  }

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

  if (current.data?.role !== "owner" && current.data?.role !== "admin") {
    return (
      <div className="flex min-h-svh items-center justify-center p-6 text-sm">
        You don&apos;t have access to admin.
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
      <header>
        <div className="text-muted-foreground text-xs uppercase tracking-wide">
          {current.data.legalName} · {current.data.role}
        </div>
        <h1 className="text-xl font-semibold">Admin</h1>
      </header>
      <div className="rounded-md border p-6 text-sm text-muted-foreground">
        Members, integrations, and rule versions land in later sprints.
      </div>
    </div>
  )
}
