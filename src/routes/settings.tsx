import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import {
  Building2,
  Check,
  CircleUserRound,
  KeyRound,
  LogOut,
  Mail,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AppShell } from '@/components/app-shell'
import { authClient } from '@/lib/auth-client'
import { cn } from '@/lib/utils'
import { api } from '../../convex/_generated/api'

const SECTIONS = ['profile', 'organizations', 'session'] as const
type SectionKey = (typeof SECTIONS)[number]

type SettingsSearch = { section?: SectionKey }

export const Route = createFileRoute('/settings')({
  head: () => ({
    meta: [
      { title: 'Settings · Title Hub' },
      {
        name: 'description',
        content: 'Manage your profile, organizations, and active session.',
      },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!(context as { isAuthenticated?: boolean }).isAuthenticated) {
      throw redirect({ to: '/signin' })
    }
  },
  validateSearch: (raw): SettingsSearch => {
    const v = (raw as Record<string, unknown>).section
    return typeof v === 'string' && (SECTIONS as readonly string[]).includes(v)
      ? { section: v as SectionKey }
      : {}
  },
  component: SettingsPage,
})

type Membership = {
  tenantId: string
  betterAuthOrgId: string
  slug: string
  legalName: string
  role: string
}

function SettingsPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const search = Route.useSearch() as SettingsSearch
  const section: SectionKey = search.section ?? 'profile'

  const session = authClient.useSession()
  const memberships = useQuery(convexQuery(api.tenants.listMine, {}))
  const isAdminQ = useQuery(convexQuery(api.tenants.amISystemAdmin, {}))
  const isSystemAdmin = isAdminQ.data === true

  const user = session.data?.user as
    | {
        name?: string | null
        email?: string | null
        emailVerified?: boolean
        createdAt?: string | number | Date
      }
    | undefined

  const list = (memberships.data?.memberships ?? []) as Membership[]
  const activeTenantId = memberships.data?.activeTenantId ?? null
  const activeOrg = list.find((m) => m.tenantId === activeTenantId) ?? null

  const onSignOut = async () => {
    // Navigate first so the settings tree unmounts in a single transition;
    // signOut + cache clear + route invalidation happen behind the new page.
    // Mirrors app-sidebar.tsx onSignOut — keep them in sync.
    await router.navigate({ to: '/signin' })
    await authClient.signOut()
    queryClient.clear()
    await router.invalidate()
  }

  const goto = (s: SectionKey) =>
    navigate({ to: '/settings', search: s === 'profile' ? {} : { section: s } })

  return (
    <AppShell
      isAuthenticated
      title="Settings"
      subtitle="Account, organizations, and session."
    >
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-10">
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <IdentityHero
            name={user?.name ?? ''}
            email={user?.email ?? ''}
            verified={user?.emailVerified ?? false}
            memberSince={user?.createdAt}
            activeOrg={activeOrg}
          />
          <SettingsNav current={section} onSelect={goto} />
        </aside>

        <main className="min-w-0">
          {section === 'profile' && (
            <ProfileSection
              name={user?.name ?? ''}
              email={user?.email ?? ''}
              verified={user?.emailVerified ?? false}
              loading={session.isPending}
            />
          )}
          {section === 'organizations' && (
            <OrganizationsSection
              memberships={list}
              activeTenantId={activeTenantId}
              isSystemAdmin={isSystemAdmin}
            />
          )}
          {section === 'session' && <SessionSection onSignOut={onSignOut} />}
        </main>
      </div>
    </AppShell>
  )
}

// ─── Left rail ──────────────────────────────────────────────────────────

function IdentityHero({
  name,
  email,
  verified,
  memberSince,
  activeOrg,
}: {
  name: string
  email: string
  verified: boolean
  memberSince?: string | number | Date
  activeOrg: Membership | null
}) {
  const monogram = useMemo(() => initials(name || email || '?'), [name, email])
  const since = memberSince ? new Date(memberSince) : null

  return (
    <div className="relative mb-4 overflow-hidden rounded-2xl border border-border/60 bg-card/70 p-4 shadow-[0_1px_0_rgba(0,0,0,0.02),0_24px_48px_-32px_rgba(64,35,63,0.25)] sm:mb-6 sm:rounded-3xl sm:p-6">
      <div
        className="pointer-events-none absolute -top-20 -right-16 size-48 rounded-full opacity-70 blur-3xl"
        style={{
          background:
            'radial-gradient(closest-side, rgba(183,134,37,0.35), transparent 70%)',
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{
          background:
            'linear-gradient(90deg, transparent, rgba(64,35,63,0.35), transparent)',
        }}
        aria-hidden
      />

      {/* Horizontal compact layout on mobile, centered hero on lg+. */}
      <div className="relative flex items-center gap-4 lg:flex-col lg:items-center lg:text-center">
        <div className="relative shrink-0">
          <div
            className="absolute -inset-2 rounded-full opacity-60 blur-xl"
            style={{
              background:
                'radial-gradient(closest-side, rgba(183,134,37,0.45), transparent 70%)',
            }}
            aria-hidden
          />
          <div className="relative grid size-12 place-items-center rounded-full bg-gradient-to-br from-[#f3d08a] via-[#d6a447] to-[#8c6210] font-serif text-lg font-semibold text-[#40233f] shadow-inner ring-1 ring-[#40233f]/15 sm:size-14 sm:text-xl lg:size-16 lg:text-2xl">
            {monogram || <CircleUserRound className="size-6 lg:size-7" />}
          </div>
        </div>
        <div className="min-w-0 flex-1 lg:mt-4 lg:flex-none">
          <div className="truncate font-serif text-base font-semibold tracking-tight text-[#40233f] sm:text-lg lg:text-xl">
            {name || '—'}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground lg:mt-1 lg:justify-center">
            <Mail className="size-3 shrink-0" />
            <span className="truncate">{email || 'no email'}</span>
            {verified && (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-[#3f7c64]/25 bg-[#3f7c64]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#3f7c64] sm:text-xs"
                title="Verified"
              >
                <Check className="size-2.5" />
                verified
              </span>
            )}
          </div>
          {since && (
            <div className="mt-2 hidden text-xs text-muted-foreground/70 lg:block">
              Member since{' '}
              {since.toLocaleDateString(undefined, {
                month: 'long',
                year: 'numeric',
              })}
            </div>
          )}
        </div>
      </div>

      {activeOrg && (
        <>
          <div
            className="my-4 h-px sm:my-5"
            style={{
              background:
                'linear-gradient(90deg, transparent, rgba(64,35,63,0.18), transparent)',
            }}
          />
          <div className="relative">
            <div className="mb-1.5 text-xs font-medium text-muted-foreground/80">
              Active organization
            </div>
            <div className="flex items-center gap-2.5">
              <div className="grid size-8 shrink-0 place-items-center rounded-xl bg-[#40233f] text-xs font-semibold text-[#f3d08a] ring-1 ring-[#40233f]/40">
                {initials(activeOrg.legalName)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {activeOrg.legalName}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {activeOrg.slug} · <RoleLabel role={activeOrg.role} />
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function SettingsNav({
  current,
  onSelect,
}: {
  current: SectionKey
  onSelect: (s: SectionKey) => void
}) {
  const items: Array<{
    key: SectionKey
    label: string
    icon: React.ReactNode
    hint: string
  }> = [
    {
      key: 'profile',
      label: 'Profile',
      icon: <CircleUserRound className="size-4" />,
      hint: 'Name, email',
    },
    {
      key: 'organizations',
      label: 'Organizations',
      icon: <Building2 className="size-4" />,
      hint: 'Switch · roles',
    },
    {
      key: 'session',
      label: 'Session',
      icon: <KeyRound className="size-4" />,
      hint: 'Sign out',
    },
  ]
  return (
    <nav
      aria-label="Settings sections"
      className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0"
    >
      {items.map((it) => {
        const active = it.key === current
        return (
          <Button
            key={it.key}
            type="button"
            variant="ghost"
            onClick={() => onSelect(it.key)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group/navitem relative h-auto shrink-0 justify-start gap-2 rounded-full px-3.5 py-2 text-left font-normal whitespace-nowrap transition-all lg:w-full lg:gap-3 lg:rounded-2xl lg:px-4 lg:py-2.5 lg:whitespace-normal',
              active
                ? 'bg-[#40233f]/[0.10] text-foreground shadow-[inset_0_0_0_1px_rgba(64,35,63,0.08)] hover:bg-[#40233f]/[0.12]'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            )}
          >
            <span
              className={cn(
                'flex size-4 shrink-0 items-center justify-center transition-colors',
                active ? 'text-[#b78625]' : ''
              )}
            >
              {it.icon}
            </span>
            <span className="flex flex-1 flex-col leading-tight">
              <span
                className={cn(
                  'text-sm transition-colors',
                  active ? 'font-medium text-foreground' : 'font-medium'
                )}
              >
                {it.label}
              </span>
              <span className="hidden text-xs text-muted-foreground/70 lg:block">
                {it.hint}
              </span>
            </span>
            <span
              className={cn(
                'ml-auto hidden size-1.5 shrink-0 rounded-full transition-all lg:block',
                active
                  ? 'bg-[#b78625] shadow-[0_0_0_3px_rgba(183,134,37,0.18)]'
                  : 'bg-transparent'
              )}
              aria-hidden
            />
          </Button>
        )
      })}
    </nav>
  )
}

// ─── Right pane sections ────────────────────────────────────────────────

function SectionHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string
  title: string
  description?: string
}) {
  return (
    <header className="mb-8">
      <div className="text-xs font-medium text-[#b78625]">{eyebrow}</div>
      <h2 className="mt-1.5 font-serif text-3xl font-semibold tracking-tight text-[#40233f]">
        {title}
      </h2>
      <div
        className="mt-3 h-px w-12"
        style={{
          background:
            'linear-gradient(90deg, #b78625 0%, rgba(183,134,37,0.1) 100%)',
        }}
      />
      {description && (
        <p className="mt-4 max-w-prose text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
    </header>
  )
}

function ProfileSection({
  name,
  email,
  verified,
  loading,
}: {
  name: string
  email: string
  verified: boolean
  loading: boolean
}) {
  const [draft, setDraft] = useState(name)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setDraft(name)
  }, [name])

  const dirty = draft.trim() !== name.trim()

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!dirty) return
    setPending(true)
    setError(null)
    setSaved(false)
    try {
      const res = await authClient.updateUser({ name: draft.trim() })
      const errMsg = (res as { error?: { message?: string } | null }).error
        ?.message
      if (errMsg) throw new Error(errMsg)
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <section>
      <SectionHeader
        eyebrow="01 — Identity"
        title="Profile"
        description="How you appear across files, audit trails, and invitations sent from this account."
      />
      <form onSubmit={onSave} className="flex flex-col gap-7">
        <FieldRow
          label="Display name"
          hint="Visible to your teammates and on every audit event."
        >
          <Input
            id="settings-name"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            required
            minLength={1}
            disabled={loading}
            className="rounded-xl"
          />
        </FieldRow>

        <FieldRow
          label="Email"
          hint={
            verified
              ? 'Verified. Used for sign-in, magic links, and notifications.'
              : 'Unverified. Check your inbox for a confirmation.'
          }
        >
          <div className="flex items-center gap-2">
            <Input
              id="settings-email"
              value={email}
              disabled
              className="rounded-xl"
            />
            <span
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
                verified
                  ? 'border border-[#3f7c64]/25 bg-[#3f7c64]/10 text-[#3f7c64]'
                  : 'border border-[#c9652e]/30 bg-[#c9652e]/10 text-[#a4501f]'
              )}
            >
              {verified ? <ShieldCheck className="size-3" /> : null}
              {verified ? 'Verified' : 'Unverified'}
            </span>
          </div>
        </FieldRow>

        <Divider />

        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {error && <span className="text-destructive">{error}</span>}
            {saved && !error && <span className="text-[#3f7c64]">Saved.</span>}
            {!error && !saved && dirty && <span>Unsaved changes.</span>}
          </div>
          <Button
            type="submit"
            disabled={pending || !dirty || !draft.trim()}
            className="rounded-xl"
          >
            {pending ? 'Saving...' : 'Save changes'}
          </Button>
        </div>
      </form>
    </section>
  )
}

function OrganizationsSection({
  memberships,
  activeTenantId,
  isSystemAdmin,
}: {
  memberships: Membership[]
  activeTenantId: string | null
  isSystemAdmin: boolean
}) {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onSwitch = async (orgId: string) => {
    setPending(orgId)
    setError(null)
    try {
      const res = await authClient.organization.setActive({
        organizationId: orgId,
      })
      if (res.error)
        throw new Error(res.error.message ?? 'Failed to switch organization.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

  return (
    <section>
      <SectionHeader
        eyebrow="02 — Tenancy"
        title="Organizations"
        description="You can belong to many organizations. Only one is active per session — switching changes the data scope across the entire app."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className="grid size-5 place-items-center rounded-full bg-[#40233f]/[0.06] text-xs font-medium text-[#40233f]"
            aria-hidden
          >
            {memberships.length}
          </span>
          <span>{memberships.length === 1 ? 'membership' : 'memberships'}</span>
        </div>
        <Button asChild variant="outline" size="sm" className="rounded-xl">
          <Link to="/tenants">+ New organization</Link>
        </Button>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {memberships.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 px-6 py-12 text-center">
          <div className="mx-auto grid size-10 place-items-center rounded-full bg-[#40233f]/[0.06] text-[#40233f]">
            <Building2 className="size-5" />
          </div>
          <div className="mt-3 font-serif text-lg text-[#40233f]">
            {isSystemAdmin ? 'No organizations yet' : 'Awaiting an invitation'}
          </div>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            {isSystemAdmin
              ? 'Create your first organization to start opening files and inviting teammates.'
              : "Your account is set up, but you haven't been invited to an organization yet. Ask your administrator to send you an invitation."}
          </p>
          {isSystemAdmin && (
            <Button asChild className="mt-4 rounded-xl">
              <Link to="/">Create one</Link>
            </Button>
          )}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {memberships.map((m) => {
            const isActive = m.tenantId === activeTenantId
            return (
              <li
                key={m.tenantId}
                className={cn(
                  'group/orgrow relative flex flex-wrap items-center gap-4 rounded-2xl border bg-card/60 px-4 py-3 transition-all',
                  isActive
                    ? 'border-[#40233f]/15 bg-[#40233f]/[0.04] shadow-[inset_0_0_0_1px_rgba(64,35,63,0.06)]'
                    : 'border-border/60 hover:border-border hover:shadow-[0_1px_0_rgba(0,0,0,0.02),0_18px_36px_-28px_rgba(64,35,63,0.18)]'
                )}
                aria-current={isActive ? 'true' : undefined}
              >
                <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#40233f] font-serif text-sm font-semibold text-[#f3d08a] ring-1 ring-[#40233f]/40">
                  {initials(m.legalName)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-[#40233f]">
                    {m.legalName}
                  </div>
                  <div className="mt-0.5 inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono text-xs">{m.slug}</span>
                    <span aria-hidden>·</span>
                    <RolePill role={m.role} />
                  </div>
                </div>
                {!isActive ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onSwitch(m.betterAuthOrgId)}
                    disabled={pending !== null}
                    className="rounded-xl"
                  >
                    {pending === m.betterAuthOrgId ? 'Switching...' : 'Switch'}
                  </Button>
                ) : (
                  <span
                    className="mr-2 ml-auto size-1.5 shrink-0 rounded-full bg-[#b78625] shadow-[0_0_0_3px_rgba(183,134,37,0.18)]"
                    aria-label="Active organization"
                    title="Active organization"
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function SessionSection({ onSignOut }: { onSignOut: () => void }) {
  const [pending, setPending] = useState(false)
  return (
    <section>
      <SectionHeader
        eyebrow="03 — Access"
        title="Session"
        description="Sign out of this browser. Your token is revoked immediately."
      />
      <div className="rounded-2xl border border-border/60 bg-card/60 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-[#40233f]/[0.06] text-[#40233f]">
              <KeyRound className="size-4" />
            </div>
            <div>
              <div className="font-medium">This device</div>
              <div className="text-xs text-muted-foreground">
                Active session backed by a Better Auth bearer token in this
                browser.
              </div>
            </div>
          </div>
          <Button
            variant="outline"
            disabled={pending}
            onClick={async () => {
              setPending(true)
              try {
                await onSignOut()
              } finally {
                setPending(false)
              }
            }}
            className="rounded-xl border-destructive/30 text-destructive hover:bg-destructive/5 hover:text-destructive"
          >
            <LogOut className="size-4" />
            {pending ? 'Signing out...' : 'Sign out'}
          </Button>
        </div>
      </div>
    </section>
  )
}

// ─── Bits ───────────────────────────────────────────────────────────────

function FieldRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid items-start gap-3 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-8">
      <div className="pt-2">
        <Label className="text-sm font-medium text-foreground">{label}</Label>
        {hint && (
          <p className="mt-1 max-w-[18rem] text-xs leading-relaxed text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
      <div className="max-w-md">{children}</div>
    </div>
  )
}

function Divider() {
  return (
    <div
      className="h-px"
      style={{
        background:
          'linear-gradient(90deg, transparent, rgba(64,35,63,0.12) 20%, rgba(64,35,63,0.12) 80%, transparent)',
      }}
    />
  )
}

const ROLE_TONE: Record<
  string,
  { bg: string; text: string; border: string; label: string }
> = {
  owner: {
    bg: 'bg-[#40233f]/[0.08]',
    text: 'text-[#40233f]',
    border: 'border-[#40233f]/25',
    label: 'Owner',
  },
  admin: {
    bg: 'bg-[#3f668f]/10',
    text: 'text-[#3f668f]',
    border: 'border-[#3f668f]/25',
    label: 'Admin',
  },
  processor: {
    bg: 'bg-[#3f7c64]/10',
    text: 'text-[#3f7c64]',
    border: 'border-[#3f7c64]/25',
    label: 'Processor',
  },
  closer: {
    bg: 'bg-[#c9652e]/10',
    text: 'text-[#a4501f]',
    border: 'border-[#c9652e]/30',
    label: 'Closer',
  },
  reviewer: {
    bg: 'bg-muted',
    text: 'text-foreground',
    border: 'border-border',
    label: 'Reviewer',
  },
  readonly: {
    bg: 'bg-muted',
    text: 'text-muted-foreground',
    border: 'border-border',
    label: 'Read-only',
  },
}

function RolePill({ role }: { role: string }) {
  const tone = ROLE_TONE[role] ?? ROLE_TONE.readonly
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs font-medium',
        tone.bg,
        tone.text,
        tone.border
      )}
    >
      {tone.label}
    </span>
  )
}

function RoleLabel({ role }: { role: string }) {
  return <span>{ROLE_TONE[role]?.label ?? role}</span>
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts
    .map((p) => p[0])
    .filter(Boolean)
    .join('')
    .toUpperCase()
}
