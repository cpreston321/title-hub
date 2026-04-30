import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { convexQuery, useConvexMutation } from "@convex-dev/react-query"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { AppShell } from "@/components/app-shell"
import { authClient } from "@/lib/auth-client"
import { api } from "../../../convex/_generated/api"
import type { Id } from "../../../convex/_generated/dataModel"

export const Route = createFileRoute("/admin/")({
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
    return (
      <AppShell isAuthenticated title="Admin">
        <p className="text-muted-foreground text-sm">Loading...</p>
      </AppShell>
    )
  }

  if (current.error) {
    const msg = current.error.message
    if (/NO_ACTIVE_TENANT|NOT_A_MEMBER|TENANT_NOT_FOUND/.test(msg)) {
      return (
        <AppShell isAuthenticated title="Admin">
          <Card className="mx-auto max-w-xl">
            <CardHeader>
              <CardTitle>No active organization</CardTitle>
              <CardDescription>
                You need to choose or create one before accessing admin.
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
      <AppShell isAuthenticated title="Admin">
        <p className="text-destructive text-sm">Error: {msg}</p>
      </AppShell>
    )
  }

  if (current.data?.role !== "owner" && current.data?.role !== "admin") {
    return (
      <AppShell isAuthenticated title="Admin">
        <Card className="mx-auto max-w-xl">
          <CardHeader>
            <CardTitle>No access</CardTitle>
            <CardDescription>
              Admin requires the owner or admin role.
            </CardDescription>
          </CardHeader>
        </Card>
      </AppShell>
    )
  }

  return (
    <AppShell
      isAuthenticated
      title="Admin"
      subtitle={`${current.data.legalName} · ${current.data.role}`}
      actions={
        <Button asChild variant="outline" size="sm">
          <Link to="/admin/rules">Recording rules →</Link>
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        <MembersPanel />
        <InvitationsPanel betterAuthOrgId={current.data.betterAuthOrgId} />
      </div>
    </AppShell>
  )
}

function MembersPanel() {
  const members = useQuery(convexQuery(api.tenants.listMembers, {}))
  const setRole = useConvexMutation(api.tenants.setMemberRole)
  const setNpi = useConvexMutation(api.tenants.setMemberNpiAccess)
  const [error, setError] = useState<string | null>(null)
  const list = members.data ?? []

  const onRoleChange = async (
    memberId: Id<"tenantMembers">,
    role:
      | "owner"
      | "admin"
      | "processor"
      | "closer"
      | "reviewer"
      | "readonly",
  ) => {
    try {
      await setRole({ memberId, role })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onNpiChange = async (
    memberId: Id<"tenantMembers">,
    canViewNpi: boolean,
  ) => {
    try {
      await setNpi({ memberId, canViewNpi })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
        <CardDescription>
          Role drives permissions; NPI gates access to tokenized fields.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {error && <p className="text-destructive text-sm">{error}</p>}
        {list.length === 0 ? (
          <div className="text-muted-foreground rounded-md border border-dashed border-border/60 p-3 text-sm">
            No members.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {list.map((m) => (
              <li
                key={m._id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 p-3 text-sm"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{m.email}</div>
                  <div className="text-muted-foreground text-xs">{m.status}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={m.role}
                    onValueChange={(v) =>
                      onRoleChange(
                        m._id as Id<"tenantMembers">,
                        v as
                          | "owner"
                          | "admin"
                          | "processor"
                          | "closer"
                          | "reviewer"
                          | "readonly",
                      )
                    }
                  >
                    <SelectTrigger size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="owner">Owner</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="processor">Processor</SelectItem>
                      <SelectItem value="closer">Closer</SelectItem>
                      <SelectItem value="reviewer">Reviewer</SelectItem>
                      <SelectItem value="readonly">Read-only</SelectItem>
                    </SelectContent>
                  </Select>
                  <Label
                    htmlFor={`npi-${m._id}`}
                    className="text-muted-foreground gap-1.5 text-xs font-normal"
                  >
                    <Checkbox
                      id={`npi-${m._id}`}
                      checked={m.canViewNpi}
                      onCheckedChange={(checked) =>
                        onNpiChange(
                          m._id as Id<"tenantMembers">,
                          checked === true,
                        )
                      }
                    />
                    NPI
                  </Label>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function InvitationsPanel({ betterAuthOrgId }: { betterAuthOrgId: string }) {
  const invites = useQuery(convexQuery(api.tenants.listPendingInvitations, {}))
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<"owner" | "admin" | "member">("member")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)

  const onInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    setPending(true)
    setError(null)
    setSentTo(null)
    try {
      const res = await authClient.organization.inviteMember({
        email,
        role,
        organizationId: betterAuthOrgId,
      })
      if (res.error) throw new Error(res.error.message ?? "Invite failed")
      setSentTo(email)
      setEmail("")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  const list = invites.data ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invitations</CardTitle>
        <CardDescription>
          Invite teammates by email. Better Auth handles the verification flow.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form onSubmit={onInvite} className="flex flex-wrap items-center gap-2">
          <Input
            type="email"
            required
            placeholder="email@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="max-w-xs"
          />
          <Select
            value={role}
            onValueChange={(v) =>
              setRole(v as "owner" | "admin" | "member")
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">Member</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="owner">Owner</SelectItem>
            </SelectContent>
          </Select>
          <Button type="submit" disabled={pending}>
            {pending ? "Sending..." : "Invite"}
          </Button>
          {sentTo && (
            <span className="text-xs text-[#3f7c64]">Invited {sentTo}</span>
          )}
          {error && <span className="text-destructive text-xs">{error}</span>}
        </form>

        <div className="text-muted-foreground text-xs uppercase tracking-wide">
          Pending
        </div>
        {list.length === 0 ? (
          <div className="text-muted-foreground rounded-md border border-dashed border-border/60 p-3 text-sm">
            No pending invitations.
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {list.map((i) => (
              <li
                key={i._id}
                className="flex items-center justify-between rounded-md border border-border/60 p-3 text-sm"
              >
                <div>
                  <div className="font-medium">{i.email}</div>
                  <div className="text-muted-foreground text-xs">
                    {i.role ?? "member"}
                    {i.expiresAt
                      ? ` · expires ${new Date(i.expiresAt).toLocaleDateString()}`
                      : ""}
                  </div>
                </div>
                <span className="text-muted-foreground text-xs">
                  {i.status ?? "pending"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
