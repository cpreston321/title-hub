import { Link, useLocation } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { convexQuery } from "@convex-dev/react-query"
import {
  LayoutDashboard,
  FolderOpen,
  Shield,
  ScrollText,
  Building2,
  ScanLine,
  Wallet,
  ChartLine,
} from "lucide-react"

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
} from "@/components/ui/sidebar"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { api } from "../../convex/_generated/api"

type AppSidebarProps = {
  isAuthenticated: boolean
}

export function AppSidebar({ isAuthenticated }: AppSidebarProps) {
  const location = useLocation()
  const current = useQuery({
    ...convexQuery(api.tenants.current, {}),
    enabled: isAuthenticated,
    retry: false,
  })

  const tenant = current.data ?? null

  return (
    <Sidebar
      collapsible="icon"
      className="border-r-0 [&>div[data-sidebar=sidebar]]:bg-gradient-to-b [&>div[data-sidebar=sidebar]]:from-[#40233f] [&>div[data-sidebar=sidebar]]:to-[#2f1a30]"
    >
      <SidebarHeader>
        <div className="flex items-center gap-3 px-2 pb-3 pt-1">
          <div className="grid size-10 place-items-center rounded-2xl bg-gradient-to-br from-[#f4d48f] to-[#b78625] text-[#40233f] shadow-inner">
            <ShieldMark />
          </div>
          <div className="leading-tight">
            <div className="font-serif text-lg tracking-wide text-white">
              {tenant?.legalName ?? "Title Hub"}
            </div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-white/60">
              {tenant?.slug ? `${tenant.slug} · ${tenant.role}` : "Operations"}
            </div>
          </div>
        </div>
      </SidebarHeader>
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
                active={location.pathname === "/"}
              />
              <NavLink
                to="/files"
                label="Files"
                icon={<FolderOpen className="size-4" />}
                active={location.pathname.startsWith("/files")}
              />
              <NavLink
                to="/admin"
                label="Admin"
                icon={<Shield className="size-4" />}
                active={
                  location.pathname === "/admin" ||
                  location.pathname.startsWith("/admin/")
                }
              />
              <NavLink
                to="/admin/rules"
                label="Recording rules"
                icon={<ScrollText className="size-4" />}
                active={location.pathname.startsWith("/admin/rules")}
              />
            </SidebarMenu>
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
        <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-3">
          <Avatar className="bg-gradient-to-br from-[#f3d08a] to-[#b78625] text-[#40233f]">
            <AvatarFallback className="bg-transparent text-[#40233f] font-semibold">
              {tenant ? initials(tenant.legalName) : "TH"}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-medium text-white">
              {tenant?.legalName ?? "Sign in"}
            </div>
            <div className="truncate text-xs text-white/60">
              {tenant?.role ?? "no active org"}
            </div>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}

function NavLink({
  to,
  label,
  icon,
  active,
  badge,
}: {
  to: string
  label: string
  icon: React.ReactNode
  active: boolean
  badge?: string
}) {
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
    .join("")
    .toUpperCase()
}
