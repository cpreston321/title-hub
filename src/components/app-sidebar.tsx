import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { useState } from 'react'
import {
  LayoutDashboard,
  FolderOpen,
  Shield,
  ScrollText,
  Building2,
  ScanLine,
  Wallet,
  ChartLine,
  ChevronsUpDown,
  Building,
  Settings as SettingsIcon,
  LogOut,
  Check,
  Loader2,
  Plus,
} from 'lucide-react'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from '@/components/ui/sidebar'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { authClient } from '@/lib/auth-client'
import { api } from '../../convex/_generated/api'

type AppSidebarProps = {
  isAuthenticated: boolean
}

export function AppSidebar({ isAuthenticated }: AppSidebarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const current = useQuery({
    ...convexQuery(api.tenants.current, {}),
    enabled: isAuthenticated,
    retry: false,
  })
  const memberships = useQuery({
    ...convexQuery(api.tenants.listMine, {}),
    enabled: isAuthenticated,
    retry: false,
  })
  const isAdminQ = useQuery({
    ...convexQuery(api.tenants.amISystemAdmin, {}),
    enabled: isAuthenticated,
    retry: false,
  })

  const meQ = useQuery({
    ...convexQuery(api.auth.getCurrentUser, {}),
    enabled: isAuthenticated,
    retry: false,
  })

  const tenant = current.data ?? null
  const orgs = (memberships.data?.memberships ?? []) as ReadonlyArray<{
    tenantId: string
    legalName: string
    slug: string
    role: string
    betterAuthOrgId: string
  }>
  const me = meQ.data as
    | { name?: string | null; email?: string | null }
    | null
    | undefined
  const accountLabel = (me?.name && me.name.trim()) || me?.email || 'Account'
  const accountSub = me?.name && me?.email ? me.email : 'Signed in'
  const accountInitials = personInitials(me?.name, me?.email)
  const hasActiveOrg = !!tenant
  const isSystemAdmin = isAdminQ.data === true
  const [switchingTo, setSwitchingTo] = useState<string | null>(null)

  const onSignOut = async () => {
    await authClient.signOut()
    navigate({ to: '/signin' })
  }

  const onSwitchTo = async (betterAuthOrgId: string) => {
    if (switchingTo) return
    setSwitchingTo(betterAuthOrgId)
    try {
      const res = await authClient.organization.setActive({
        organizationId: betterAuthOrgId,
      })
      if (res.error) {
        throw new Error(res.error.message ?? 'Switch failed')
      }
      // Re-fetch tenant-scoped queries so the new org's data shows up.
      await queryClient.invalidateQueries()
      navigate({ to: '/' })
    } catch {
      // Surface the failure inline by reverting state; the dropdown closes
      // either way and the user can retry.
    } finally {
      setSwitchingTo(null)
    }
  }

  return (
    <Sidebar
      collapsible="icon"
      className="border-r-0 [&>div[data-sidebar=sidebar]]:bg-gradient-to-b [&>div[data-sidebar=sidebar]]:from-[#40233f] [&>div[data-sidebar=sidebar]]:to-[#2f1a30]"
    >
      <SidebarHeader>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="group/orgswitch mx-2 mt-1 mb-2 flex items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-white/10 data-[state=open]:bg-white/10"
              aria-label="Switch organization"
            >
              <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#f4d48f] to-[#b78625] text-[#40233f] shadow-inner">
                <ShieldMark />
              </div>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate font-serif text-base tracking-wide text-white">
                  {tenant?.legalName ?? 'Title Hub'}
                </div>
                <div className="truncate text-xs text-white/60">
                  {tenant
                    ? `${tenant.slug} · ${tenant.role}`
                    : hasActiveOrg
                      ? 'Loading...'
                      : 'No active org'}
                </div>
              </div>
              <ChevronsUpDown className="size-3.5 shrink-0 text-white/60 group-hover/orgswitch:text-white/85" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="bottom"
            align="start"
            sideOffset={6}
            className="w-(--radix-dropdown-menu-trigger-width) min-w-64"
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Your organizations
            </DropdownMenuLabel>
            {memberships.isLoading ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                <Loader2 className="mr-1.5 inline size-3 animate-spin" />
                Loading...
              </div>
            ) : orgs.length === 0 ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">
                You're not a member of any organization yet.
              </div>
            ) : (
              orgs.map((o) => {
                const active = o.tenantId === tenant?.tenantId
                const switching = switchingTo === o.betterAuthOrgId
                return (
                  <DropdownMenuItem
                    key={o.tenantId}
                    onSelect={(e) => {
                      e.preventDefault()
                      if (active) return
                      onSwitchTo(o.betterAuthOrgId)
                    }}
                    className={`flex items-start gap-2 ${active ? 'cursor-default' : 'cursor-pointer'}`}
                  >
                    <div className="grid size-7 shrink-0 place-items-center rounded-md border border-[#40233f]/15 bg-[#fdf6e8] text-[#40233f]">
                      <Building className="size-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-[#40233f]">
                        {o.legalName}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {o.slug} · {o.role}
                      </div>
                    </div>
                    {switching ? (
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                    ) : active ? (
                      <Check className="size-3.5 shrink-0 text-[#3f7c64]" />
                    ) : null}
                  </DropdownMenuItem>
                )
              })
            )}
            {isSystemAdmin && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/" className="flex items-center gap-2">
                    <Plus className="size-3.5" />
                    Create a new organization
                  </Link>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarHeader>

      <NewFileCTA hasActiveOrg={hasActiveOrg} />

      <SidebarSeparator className="bg-white/10" />

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-white/45">Main</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <NavLink
                to="/"
                label="Dashboard"
                icon={<LayoutDashboard className="size-4" />}
                active={location.pathname === '/'}
              />
              <NavLink
                to="/files"
                label="Files"
                icon={<FolderOpen className="size-4" />}
                active={location.pathname.startsWith('/files')}
                disabled={!hasActiveOrg}
              />
              <NavLink
                to="/admin"
                label="Admin"
                icon={<Shield className="size-4" />}
                active={location.pathname === '/admin'}
                disabled={!hasActiveOrg}
              />
              <NavLink
                to="/admin/rules"
                label="Recording rules"
                icon={<ScrollText className="size-4" />}
                active={location.pathname.startsWith('/admin/rules')}
                disabled={!hasActiveOrg}
              />
            </SidebarMenu>
            {!hasActiveOrg && !memberships.isLoading && (
              <div className="mx-2 mt-2 rounded-md border border-white/10 bg-white/5 px-2.5 py-2 text-[11px] leading-snug text-white/60">
                Pick an organization above to enable these.
              </div>
            )}
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="text-white/45">
            Operations
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <DisabledNavItem
                label="Escrow"
                icon={<Wallet className="size-4" />}
              />
              <DisabledNavItem
                label="Order management"
                icon={<ScanLine className="size-4" />}
              />
              <DisabledNavItem
                label="County connect"
                icon={<Building2 className="size-4" />}
                badge="soon"
              />
              <DisabledNavItem
                label="Analytics"
                icon={<ChartLine className="size-4" />}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="gap-3 text-white/80 hover:bg-white/10 hover:text-white data-[state=open]:bg-white/15 data-[state=open]:text-white"
                >
                  <Avatar className="bg-gradient-to-br from-[#f3d08a] to-[#b78625]">
                    <AvatarFallback className="bg-transparent font-semibold text-[#40233f]">
                      {accountInitials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1 text-left leading-tight">
                    <div className="truncate text-sm font-medium text-white">
                      {accountLabel}
                    </div>
                    <div className="truncate text-xs text-white/60">
                      {accountSub}
                    </div>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4 shrink-0 text-white/60" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="start"
                sideOffset={8}
                className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
              >
                <DropdownMenuItem asChild>
                  <Link to="/settings">
                    <SettingsIcon className="size-4" />
                    Account settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onSignOut}>
                  <LogOut className="size-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

function NewFileCTA({ hasActiveOrg }: { hasActiveOrg: boolean }) {
  if (!hasActiveOrg) {
    return (
      <div className="px-3 pb-2">
        <button
          type="button"
          disabled
          aria-disabled="true"
          title="Pick an organization first"
          className="flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-sm font-medium text-white/40"
        >
          <Plus className="size-4" />
          New file
        </button>
      </div>
    )
  }
  return (
    <div className="px-3 pb-2">
      <Link
        to="/files"
        search={{ new: true }}
        className="group/newfile flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-[#f4d48f] to-[#b78625] px-3 py-2 text-sm font-semibold text-[#40233f] shadow-sm ring-1 ring-[#40233f]/15 transition ring-inset hover:from-[#f6dca0] hover:to-[#c2902c] hover:shadow"
      >
        <Plus className="size-4" />
        New file
      </Link>
    </div>
  )
}

function NavLink({
  to,
  label,
  icon,
  active,
  badge,
  disabled,
}: {
  to: string
  label: string
  icon: React.ReactNode
  active: boolean
  badge?: string
  disabled?: boolean
}) {
  if (disabled) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          disabled
          aria-disabled="true"
          title="Pick an organization first"
          className="cursor-not-allowed text-white/35 hover:bg-transparent hover:text-white/35"
        >
          {icon}
          <span>{label}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        className="text-white/80 hover:bg-white/10 hover:text-white data-[active=true]:bg-white/15 data-[active=true]:text-white"
      >
        <Link to={to}>
          {icon}
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
      {badge && (
        <SidebarMenuBadge className="bg-white/10 text-white/80">
          {badge}
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  )
}

function DisabledNavItem({
  label,
  icon,
  badge,
}: {
  label: string
  icon: React.ReactNode
  badge?: string
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        disabled
        className="cursor-not-allowed text-white/40 hover:bg-transparent hover:text-white/40"
      >
        {icon}
        <span>{label}</span>
      </SidebarMenuButton>
      {badge && (
        <SidebarMenuBadge className="bg-white/10 text-white/60">
          {badge}
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  )
}

function ShieldMark() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M9 2L14 5.5V12.5L9 16L4 12.5V5.5L9 2Z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M9 5L12 7V11L9 13L6 11V7L9 5Z"
        fill="currentColor"
        opacity="0.35"
      />
      <circle cx="9" cy="9" r="1.5" fill="currentColor" />
    </svg>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts
    .map((p) => p[0])
    .filter(Boolean)
    .join('')
    .toUpperCase()
}

function personInitials(name?: string | null, email?: string | null): string {
  if (name && name.trim()) return initials(name)
  if (email && email.length > 0) {
    const local = email.split('@')[0] ?? email
    const segs = local.split(/[._-]+/).filter(Boolean)
    if (segs.length >= 2) return (segs[0]![0]! + segs[1]![0]!).toUpperCase()
    return (local.slice(0, 2) || '··').toUpperCase()
  }
  return '··'
}
