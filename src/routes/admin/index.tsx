import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Lock,
  Mail,
  Plug,
  ScrollText,
  Send,
  Users,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import { AppShell } from '@/components/app-shell'
import {
  PageHeaderSkeleton,
  SectionSkeleton,
} from '@/components/skeletons'
import { authClient } from '@/lib/auth-client'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

export const Route = createFileRoute('/admin/')({
  head: () => ({
    meta: [
      { title: 'Admin · Title Hub' },
      {
        name: 'description',
        content:
          'Workspace administration: members, roles, integrations, and recording rules.',
      },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!(context as { isAuthenticated?: boolean }).isAuthenticated) {
      throw redirect({ to: '/signin' })
    }
  },
  loader: ({ context }) => {
    const { queryClient } = context as { queryClient: QueryClient }
    void queryClient.ensureQueryData(convexQuery(api.tenants.current, {}))
    void queryClient.ensureQueryData(convexQuery(api.tenants.listMembers, {}))
  },
  component: AdminPage,
})

function AdminPage() {
  const current = useQuery(convexQuery(api.tenants.current, {}))

  if (current.isLoading) {
    return (
      <AppShell isAuthenticated title="Admin">
        <div className="flex flex-col gap-6 pb-12">
          <PageHeaderSkeleton />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
            <div className="lg:col-span-3">
              <SectionSkeleton rows={4} />
            </div>
            <div className="lg:col-span-2">
              <SectionSkeleton rows={3} />
            </div>
          </div>
        </div>
      </AppShell>
    )
  }

  if (current.data === null) {
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

  if (current.error) {
    return (
      <AppShell isAuthenticated title="Admin">
        <p className="text-sm text-destructive">
          Error: {current.error.message}
        </p>
      </AppShell>
    )
  }

  if (current.data?.role !== 'owner' && current.data?.role !== 'admin') {
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
    >
      <div className="flex flex-col gap-6 pb-12">
        <PageHeader
          orgName={current.data.legalName}
          role={current.data.role}
        />

        <SubAreas />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <MembersPanel />
          </div>
          <div className="lg:col-span-2">
            <InvitationsPanel betterAuthOrgId={current.data.betterAuthOrgId} />
          </div>
        </div>
      </div>
    </AppShell>
  )
}

function PageHeader({ orgName, role }: { orgName: string; role: string }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl leading-[1] font-semibold tracking-tight text-[#40233f] md:text-5xl">
            Admin
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Manage your roster and invitations, integration keys, and recording
            rules — the workshop behind the file register.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end rounded-xl border border-border/70 bg-card px-4 py-2.5 ring-1 ring-foreground/5">
          <div className="text-[10px] font-medium uppercase tracking-wider text-[#b78625]">
            Acting on behalf of
          </div>
          <div className="font-display text-sm font-semibold text-[#40233f]">
            {orgName}
          </div>
          <div className="font-numerals text-[11px] capitalize text-muted-foreground">
            {role}
          </div>
        </div>
      </div>
    </div>
  )
}

function SubAreas() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <SubAreaTile
        to="/admin/rules"
        title="Recording rules"
        description="Versioned per county and document type. Margins, fees, exhibits, notarial requirements."
        icon={<ScrollText className="size-5" />}
      />
      <SubAreaTile
        to="/admin/integrations"
        title="Integrations"
        description="Tokens, webhooks, and third-party services bound to this tenant."
        icon={<Plug className="size-5" />}
      />
    </div>
  )
}

function SubAreaTile({
  to,
  title,
  description,
  icon,
}: {
  to: string
  title: string
  description: string
  icon: React.ReactNode
}) {
  return (
    <Link
      to={to}
      className="group/tile flex flex-col rounded-2xl border border-border/70 bg-card px-5 py-4 shadow-sm ring-1 ring-foreground/5 transition hover:border-[#593157]/30 hover:shadow-md"
    >
      <div className="flex items-center gap-3">
        <div className="grid size-9 place-items-center rounded-md border border-[#40233f]/15 bg-[#fdf6e8] text-[#40233f]">
          {icon}
        </div>
        <div className="font-display text-lg font-semibold tracking-tight text-[#40233f]">
          {title}
        </div>
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground transition group-hover/tile:translate-x-0.5 group-hover/tile:text-[#40233f]">
          Open →
        </span>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
    </Link>
  )
}

const ROLE_OPTIONS = [
  { id: 'owner', label: 'Owner', desc: 'All powers' },
  { id: 'admin', label: 'Admin', desc: 'Manage roster + rules' },
  { id: 'processor', label: 'Processor', desc: 'Open + work files' },
  { id: 'closer', label: 'Closer', desc: 'Take files to policy' },
  { id: 'reviewer', label: 'Reviewer', desc: 'Read + comment' },
  { id: 'readonly', label: 'Read-only', desc: 'View register' },
] as const
type RoleId = (typeof ROLE_OPTIONS)[number]['id']

// Tone-coded look per role — same palette tokens used everywhere else
// (orders / files / mail). The Select trigger borrows these so each row's
// role is readable at a glance without scanning the label.
const ROLE_TONE: Record<
  RoleId,
  { bg: string; text: string; ring: string; dot: string }
> = {
  owner: {
    bg: 'bg-[#f2e7f1]',
    text: 'text-[#40233f]',
    ring: 'ring-[#593157]/30',
    dot: 'bg-[#593157]',
  },
  admin: {
    bg: 'bg-[#fdf6e8]',
    text: 'text-[#7a5818]',
    ring: 'ring-[#b78625]/35',
    dot: 'bg-[#b78625]',
  },
  processor: {
    bg: 'bg-[#e8f0f8]',
    text: 'text-[#2c4a6b]',
    ring: 'ring-[#3f668f]/30',
    dot: 'bg-[#3f668f]',
  },
  closer: {
    bg: 'bg-[#e6f3ed]',
    text: 'text-[#2f5d4b]',
    ring: 'ring-[#3f7c64]/30',
    dot: 'bg-[#3f7c64]',
  },
  reviewer: {
    bg: 'bg-[#fde9dc]',
    text: 'text-[#7a3d18]',
    ring: 'ring-[#c9652e]/30',
    dot: 'bg-[#c9652e]',
  },
  readonly: {
    bg: 'bg-card',
    text: 'text-muted-foreground',
    ring: 'ring-border',
    dot: 'bg-muted-foreground/40',
  },
}

function roleLabel(id: RoleId): string {
  return ROLE_OPTIONS.find((r) => r.id === id)?.label ?? id
}

function MembersPanel() {
  const current = useQuery(convexQuery(api.tenants.current, {}))
  const members = useQuery(convexQuery(api.tenants.listMembers, {}))
  const setRole = useConvexMutation(api.tenants.setMemberRole)
  const setNpi = useConvexMutation(api.tenants.setMemberNpiAccess)
  const [error, setError] = useState<string | null>(null)
  const list = members.data ?? []
  const selfMemberId = current.data?.memberId ?? null

  const onRoleChange = async (memberId: Id<'tenantMembers'>, role: RoleId) => {
    try {
      await setRole({ memberId, role })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onNpiChange = async (
    memberId: Id<'tenantMembers'>,
    canViewNpi: boolean
  ) => {
    try {
      await setNpi({ memberId, canViewNpi })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <article className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/5">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border/70 px-6 pt-5 pb-4">
        <div className="flex items-center gap-2.5">
          <Users className="size-4 text-[#40233f]" />
          <h2 className="font-display text-xl leading-none font-semibold tracking-tight text-[#40233f]">
            Members
          </h2>
        </div>
        <div className="font-numerals text-xs text-muted-foreground tabular-nums">
          {list.length} on staff
        </div>
      </header>

      {error && (
        <div className="mx-6 mt-4 rounded-md border border-[#b94f58]/30 bg-[#fdecee] px-3 py-2 text-sm text-[#8a3942]">
          {error}
        </div>
      )}

      {list.length === 0 ? (
        <div className="px-6 py-14 text-center">
          <div className="font-display text-xl font-semibold text-[#40233f]">
            The roster is empty.
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Issue an invitation in the panel beside.
          </p>
        </div>
      ) : (
        <ol className="divide-y divide-border/50">
          <li className="hidden grid-cols-[1fr_9rem_5.5rem] items-center gap-4 bg-[#fdf6e8]/50 px-6 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground sm:grid">
            <span>Member</span>
            <span>Role</span>
            <span className="text-right">NPI access</span>
          </li>
          {list.map((m) => {
            const tone = ROLE_TONE[m.role]
            const isSelf = selfMemberId === m._id
            const lockTitle =
              'You can\'t change your own role or NPI access. Ask another admin or owner to make this change.'
            return (
              <li
                key={m._id}
                className={`grid grid-cols-1 gap-3 px-6 py-3 transition sm:grid-cols-[1fr_9rem_5.5rem] sm:items-center sm:gap-4 ${
                  isSelf
                    ? 'bg-[#fdf6e8]/40'
                    : 'hover:bg-[#fdf6e8]/30'
                }`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="relative grid size-9 shrink-0 place-items-center rounded-full bg-[#fdf6e8] ring-1 ring-[#40233f]/15">
                    <span className="font-display text-xs font-semibold text-[#40233f]">
                      {initials(m.email)}
                    </span>
                    <span
                      className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-card ${
                        m.status === 'active'
                          ? 'bg-[#3f7c64]'
                          : 'bg-muted-foreground/40'
                      }`}
                      aria-hidden
                    />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="font-numerals truncate text-sm font-medium text-[#2e2430]">
                        {m.email}
                      </div>
                      {isSelf && (
                        <span className="inline-flex items-center rounded-full bg-[#40233f] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[#f6e8d9]">
                          You
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ring-1 ring-inset ${
                          m.status === 'active'
                            ? 'bg-[#e6f3ed] text-[#2f5d4b] ring-[#3f7c64]/30'
                            : 'bg-muted text-muted-foreground ring-border'
                        }`}
                      >
                        <span
                          className={`size-1 rounded-full ${
                            m.status === 'active'
                              ? 'bg-[#3f7c64]'
                              : 'bg-muted-foreground/50'
                          }`}
                        />
                        {m.status}
                      </span>
                    </div>
                  </div>
                </div>

                {isSelf ? (
                  <span
                    title={lockTitle}
                    aria-label={lockTitle}
                    className={`inline-flex w-fit cursor-not-allowed items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium opacity-70 ring-1 ring-inset ${tone.bg} ${tone.text} ${tone.ring}`}
                  >
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${tone.dot}`}
                    />
                    {roleLabel(m.role)}
                    <Lock className="size-3 opacity-70" />
                  </span>
                ) : (
                  <Select
                    value={m.role}
                    onValueChange={(v) =>
                      onRoleChange(m._id as Id<'tenantMembers'>, v as RoleId)
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label={`Change role for ${m.email}`}
                      className={`gap-1.5 rounded-full border-0 px-2.5 text-xs font-medium ring-1 ring-inset transition hover:brightness-[0.97] focus-visible:ring-2 focus-visible:ring-[#593157]/40 ${tone.bg} ${tone.text} ${tone.ring}`}
                    >
                      <span className="flex items-center gap-1.5">
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${tone.dot}`}
                        />
                        {roleLabel(m.role)}
                      </span>
                    </SelectTrigger>
                    <SelectContent position="popper" align="start" sideOffset={4}>
                      {ROLE_OPTIONS.map((r) => {
                        const t = ROLE_TONE[r.id]
                        return (
                          <SelectItem
                            key={r.id}
                            value={r.id}
                            className="py-2"
                          >
                            <span className="flex items-start gap-2.5">
                              <span
                                className={`mt-1 inline-flex size-2 shrink-0 rounded-full ${t.dot}`}
                              />
                              <span className="flex flex-col items-start">
                                <span className="text-sm font-medium text-[#40233f]">
                                  {r.label}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {r.desc}
                                </span>
                              </span>
                            </span>
                          </SelectItem>
                        )
                      })}
                    </SelectContent>
                  </Select>
                )}

                <NpiSwitch
                  id={`npi-${m._id}`}
                  checked={m.canViewNpi}
                  disabled={isSelf}
                  disabledTitle={isSelf ? lockTitle : undefined}
                  onChange={(next) =>
                    onNpiChange(m._id as Id<'tenantMembers'>, next)
                  }
                />
              </li>
            )
          })}
        </ol>
      )}

      <footer className="border-t border-border/60 bg-[#fdf6e8]/40 px-6 py-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Eye className="size-3.5 text-[#3f7c64]" />
          NPI clearance gates access to tokenized fields. Owner role is required
          to edit recording rules.
        </div>
      </footer>
    </article>
  )
}

function InvitationsPanel({ betterAuthOrgId }: { betterAuthOrgId: string }) {
  const invites = useQuery(convexQuery(api.tenants.listPendingInvitations, {}))
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'owner' | 'admin' | 'member'>('member')
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
      if (res.error) throw new Error(res.error.message ?? 'Invite failed')
      setSentTo(email)
      setEmail('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  const list = invites.data ?? []

  return (
    <article className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/5">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border/70 px-6 pt-5 pb-4">
        <div className="flex items-center gap-2.5">
          <Mail className="size-4 text-[#40233f]" />
          <h2 className="font-display text-xl leading-none font-semibold tracking-tight text-[#40233f]">
            Invitations
          </h2>
        </div>
      </header>

      <form
        onSubmit={onInvite}
        className="flex flex-col gap-3 border-b border-border/60 bg-[#fdf6e8]/40 px-6 py-5"
      >
        <div className="flex flex-col gap-2">
          <Label
            htmlFor="invite-email"
            className="text-xs font-medium text-[#40233f]"
          >
            Address
          </Label>
          <Input
            id="invite-email"
            type="email"
            required
            placeholder="recipient@firm.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="font-numerals"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label className="text-xs font-medium text-[#40233f]">Capacity</Label>
          <div className="grid grid-cols-3 gap-1.5 rounded-full bg-card p-1 ring-1 ring-border/60">
            {(['member', 'admin', 'owner'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRole(r)}
                className={`rounded-full px-3 py-1.5 text-xs transition ${
                  role === r
                    ? 'bg-[#40233f] text-[#f6e8d9] shadow-sm'
                    : 'text-muted-foreground hover:text-[#40233f]'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p className="rounded-md border border-[#b94f58]/30 bg-[#fdecee] px-3 py-2 text-sm text-[#8a3942]">
            {error}
          </p>
        )}
        {sentTo && (
          <p className="font-numerals flex items-center gap-2 rounded-md border border-[#3f7c64]/30 bg-[#e6f3ed] px-3 py-2 text-xs text-[#2f5d4b]">
            <CheckCircle2 className="size-3.5" />
            Dispatched to {sentTo}
          </p>
        )}

        <Button type="submit" disabled={pending} className="gap-2 self-start">
          <Send className="size-4" />
          {pending ? 'Dispatching...' : 'Send invitation'}
        </Button>
      </form>

      <div className="px-6 py-4">
        <div className="flex items-baseline justify-between border-b border-border/40 pb-2">
          <div className="text-xs font-medium uppercase tracking-wider text-[#b78625]">
            Pending invitations
          </div>
          <div className="font-numerals text-xs text-muted-foreground tabular-nums">
            {list.length}
          </div>
        </div>

        {list.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            None awaiting reply.
          </p>
        ) : (
          <ul className="flex flex-col">
            {list.map((i) => (
              <li
                key={i._id}
                className="flex items-center justify-between gap-3 border-b border-border/40 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="font-numerals truncate text-sm font-medium text-[#2e2430]">
                    {i.email}
                  </div>
                  <div className="font-numerals text-xs text-muted-foreground">
                    {i.role ?? 'member'}
                    {i.expiresAt
                      ? ` · expires ${new Date(i.expiresAt).toLocaleDateString()}`
                      : ''}
                  </div>
                </div>
                <span className="font-numerals inline-flex items-center gap-1.5 rounded-full bg-[#f8eed7] px-2.5 py-1 text-xs text-[#7a5818] ring-1 ring-[#b78625]/40 ring-inset">
                  <span className="size-1 rounded-full bg-[#b78625]" />
                  {i.status ?? 'pending'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  )
}

function initials(email: string): string {
  const local = email.split('@')[0] ?? email
  const parts = local.split(/[._-]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  return (local.slice(0, 2) || '··').toUpperCase()
}

// Switch-style NPI toggle. Visual: a 36×20 track that slides a 14px thumb
// from left to right, with an Eye / EyeOff icon inside the thumb so the
// state is readable from across the room. Built on a native button so
// keyboard activation, role="switch", and aria-checked all work without
// extra wiring.
function NpiSwitch({
  id,
  checked,
  disabled,
  disabledTitle,
  onChange,
}: {
  id: string
  checked: boolean
  disabled?: boolean
  disabledTitle?: string
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-center justify-end">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        title={disabled ? disabledTitle : undefined}
        aria-label={
          disabled
            ? (disabledTitle ?? 'NPI access locked')
            : checked
              ? 'Revoke NPI access for this member'
              : 'Grant NPI access to this member'
        }
        onClick={() => {
          if (disabled) return
          onChange(!checked)
        }}
        className={`group/npi relative inline-flex h-5 w-9 shrink-0 items-center rounded-full ring-1 ring-inset transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#593157]/40 ${
          disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
        } ${
          checked
            ? 'bg-[#e6f3ed] ring-[#3f7c64]/40'
            : 'bg-muted ring-border'
        }`}
      >
        <span
          className={`absolute top-0.5 grid size-4 place-items-center rounded-full shadow-sm transition-all ${
            checked
              ? 'left-[1.125rem] bg-[#3f7c64] text-white'
              : 'left-0.5 bg-card text-muted-foreground'
          }`}
        >
          {disabled ? (
            <Lock className="size-2.5" />
          ) : checked ? (
            <Eye className="size-2.5" />
          ) : (
            <EyeOff className="size-2.5" />
          )}
        </span>
      </button>
    </div>
  )
}
