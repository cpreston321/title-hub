import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import {
  CheckCircle2,
  ChevronLeft,
  CircleAlert,
  Plug,
  Plus,
  Power,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react'
import {
  Card,
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
  SelectValue,
} from '@/components/ui/select'
import { AppShell } from '@/components/app-shell'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

export const Route = createFileRoute('/admin/integrations')({
  head: () => ({
    meta: [
      { title: 'Integrations · Title Hub' },
      {
        name: 'description',
        content:
          'Connect Title Hub to external systems via tokens, webhooks, and API keys.',
      },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!(context as { isAuthenticated?: boolean }).isAuthenticated) {
      throw redirect({ to: '/signin' })
    }
  },
  component: IntegrationsAdminPage,
})

type Kind =
  | 'softpro_360'
  | 'softpro_standard'
  | 'qualia'
  | 'resware'
  | 'encompass'
  | 'mock'

const KIND_LABEL: Record<Kind, string> = {
  softpro_360: 'SoftPro 360',
  softpro_standard: 'SoftPro Standard (direct)',
  qualia: 'Qualia',
  resware: 'ResWare',
  encompass: 'Encompass',
  mock: 'Mock (testing)',
}

const KIND_DESCRIPTION: Record<Kind, string> = {
  softpro_360:
    "SoftPro's 360 transactional integration. Pulls files via the standard 360 transport.",
  softpro_standard: 'Direct SoftPro Select/Standard connection — coming soon.',
  qualia: 'Qualia Connect — coming soon.',
  resware: 'ResWare title production — coming soon.',
  encompass: 'Encompass loan files — coming soon.',
  mock: 'A fake source that produces synthetic files. Use this to try the sync pipeline end-to-end without real credentials.',
}

const SUPPORTED_KINDS: Array<Kind> = ['softpro_360', 'softpro_standard', 'mock']
const COMING_SOON: ReadonlySet<Kind> = new Set(['softpro_standard'])

function IntegrationsAdminPage() {
  const current = useQuery(convexQuery(api.tenants.current, {}))
  const integrations = useQuery(convexQuery(api.integrations.list, {}))
  const create = useConvexMutation(api.integrations.create)
  const setEnabled = useConvexMutation(api.integrations.setEnabled)
  const remove = useConvexMutation(api.integrations.remove)
  const runSync = useConvexMutation(api.integrations.runSync)
  const agentInstallInfo = useConvexMutation(api.integrations.agentInstallInfo)

  const [showForm, setShowForm] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [agentInfo, setAgentInfo] = useState<{
    integrationId: string
    inboundSecret: string
  } | null>(null)

  const onShowAgentInfo = async (id: Id<'integrations'>) => {
    setPending(id)
    setError(null)
    try {
      const info = await agentInstallInfo({ integrationId: id })
      setAgentInfo({
        integrationId: info.integrationId,
        inboundSecret: info.inboundSecret,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

  if (current.isLoading) {
    return (
      <AppShell isAuthenticated title="Integrations">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </AppShell>
    )
  }
  if (current.error) {
    return (
      <AppShell isAuthenticated title="Integrations">
        <p className="text-sm text-destructive">{current.error.message}</p>
      </AppShell>
    )
  }
  if (current.data?.role !== 'owner' && current.data?.role !== 'admin') {
    return (
      <AppShell isAuthenticated title="Integrations">
        <Card className="mx-auto max-w-xl">
          <CardHeader>
            <CardTitle>No access</CardTitle>
            <CardDescription>
              Integrations require the owner or admin role.
            </CardDescription>
          </CardHeader>
        </Card>
      </AppShell>
    )
  }

  const list = (integrations.data ?? []) as ReadonlyArray<IntegrationRow>

  const onToggle = async (id: Id<'integrations'>, enabled: boolean) => {
    setPending(id)
    setError(null)
    try {
      await setEnabled({ integrationId: id, enabled })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

  const onRemove = async (id: Id<'integrations'>) => {
    if (!confirm('Remove this integration? Sync history is preserved.')) return
    setPending(id)
    setError(null)
    try {
      await remove({ integrationId: id })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

  const onSync = async (id: Id<'integrations'>) => {
    setPending(id)
    setError(null)
    try {
      await runSync({ integrationId: id })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

  const stats = {
    total: list.length,
    active: list.filter((i) => i.status === 'active').length,
    error: list.filter((i) => i.status === 'error').length,
    syncedTotal: list.reduce((sum, i) => sum + i.filesSyncedTotal, 0),
  }

  return (
    <AppShell
      isAuthenticated
      title="Integrations"
      subtitle="External title-stack systems syncing files into this tenant."
      actions={
        <>
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link to="/admin">
              <ChevronLeft className="size-3.5" />
              Admin
            </Link>
          </Button>
          <Button
            onClick={() => setShowForm(!showForm)}
            className="gap-1.5"
            variant={showForm ? 'outline' : 'default'}
          >
            {showForm ? (
              <>
                <X className="size-3.5" />
                Cancel
              </>
            ) : (
              <>
                <Plus className="size-3.5" />
                New integration
              </>
            )}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6 pb-12">
        <PageHeader stats={stats} />

        {error && (
          <p className="rounded-md border border-[#b94f58]/30 bg-[#fdecee] px-3 py-2 text-sm text-[#8a3942]">
            {error}
          </p>
        )}

        {showForm && (
          <NewIntegrationForm
            onCreate={async (args) => {
              await create(args)
              setShowForm(false)
            }}
            onCancel={() => setShowForm(false)}
          />
        )}

        {list.length === 0 ? (
          <FirstIntegrationCoach onCreate={() => setShowForm(true)} />
        ) : (
          <SectionShell
            eyebrow="Section · connected"
            title="Connected systems"
            description="One row per source. Toggle a row off to pause its sync; remove a row to drop the configuration (history is preserved)."
            icon={<Plug className="size-4" />}
          >
            <ul className="flex flex-col gap-3">
              {list.map((i) => (
                <li key={i._id}>
                  <IntegrationCard
                    integration={i}
                    pending={pending === i._id}
                    onToggle={(enabled) =>
                      onToggle(i._id as Id<'integrations'>, enabled)
                    }
                    onSync={() => onSync(i._id as Id<'integrations'>)}
                    onRemove={() => onRemove(i._id as Id<'integrations'>)}
                    onShowAgentInfo={() =>
                      onShowAgentInfo(i._id as Id<'integrations'>)
                    }
                    agentInfo={agentInfo}
                  />
                </li>
              ))}
            </ul>
          </SectionShell>
        )}
      </div>
    </AppShell>
  )
}

function PageHeader({
  stats,
}: {
  stats: { total: number; active: number; error: number; syncedTotal: number }
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl leading-[1] font-semibold tracking-tight text-[#40233f] md:text-5xl">
            Integrations
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Connect external order systems — SoftPro, Qualia, Encompass — so
            their files flow into this tenant. Each row is one connection. Use a{' '}
            <strong className="font-medium text-[#40233f]">mock</strong>{' '}
            integration to try the pipeline before wiring real credentials.
          </p>
        </div>
      </div>

      {stats.total > 0 && (
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border/70 ring-1 ring-foreground/5 sm:grid-cols-4">
          <Stat
            label="Connected"
            value={String(stats.total).padStart(2, '0')}
          />
          <Stat
            label="Active"
            value={String(stats.active).padStart(2, '0')}
            tone="good"
          />
          <Stat
            label="Errors"
            value={String(stats.error).padStart(2, '0')}
            tone={stats.error > 0 ? 'warn' : undefined}
          />
          <Stat
            label="Files synced (total)"
            value={String(stats.syncedTotal).padStart(2, '0')}
          />
        </div>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'good' | 'warn'
}) {
  const valueClass =
    tone === 'good'
      ? 'text-[#2f5d4b]'
      : tone === 'warn'
        ? 'text-[#8a3942]'
        : 'text-[#40233f]'
  return (
    <div className="bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`mt-1 font-display text-2xl leading-none font-semibold tabular-nums ${valueClass}`}
      >
        {value}
      </div>
    </div>
  )
}

function SectionShell({
  eyebrow,
  title,
  description,
  icon,
  actions,
  children,
}: {
  eyebrow: string
  title: string
  description?: React.ReactNode
  icon?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <article className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/5">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 px-6 pt-5 pb-4">
        <div className="flex min-w-0 items-start gap-3">
          {icon && (
            <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-[#40233f]/15 bg-[#fdf6e8] text-[#40233f]">
              {icon}
            </div>
          )}
          <div className="min-w-0">
            <div className="text-xs font-semibold text-[#b78625]">
              {eyebrow}
            </div>
            <h2 className="font-display text-xl font-semibold tracking-tight text-[#40233f]">
              {title}
            </h2>
            {description && (
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
            )}
          </div>
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </header>
      <div className="px-6 py-5">{children}</div>
    </article>
  )
}

type IntegrationRow = {
  _id: string
  kind: Kind
  name: string
  status: 'active' | 'disabled' | 'error'
  hasCredentials: boolean
  lastSyncAt: number | null
  lastSyncStatus: 'succeeded' | 'failed' | null
  lastError: string | null
  filesSyncedTotal: number
  createdAt: number
  mode: 'pull' | 'push'
  agentLastHeartbeatAt: number | null
  agentVersion: string | null
  agentHostname: string | null
  agentWatermark: string | null
  agentStale: boolean
}

function IntegrationCard({
  integration,
  pending,
  onToggle,
  onSync,
  onRemove,
  onShowAgentInfo,
  agentInfo,
}: {
  integration: IntegrationRow
  pending: boolean
  onToggle: (enabled: boolean) => void
  onSync: () => void
  onRemove: () => void
  onShowAgentInfo: () => void
  agentInfo: { integrationId: string; inboundSecret: string } | null
}) {
  const lastSync = integration.lastSyncAt
    ? new Date(integration.lastSyncAt).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : 'never'
  const stub = !integration.hasCredentials && integration.kind !== 'mock'

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card ring-1 ring-foreground/5">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/50 bg-[#fdf6e8]/40 px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <KindBadge kind={integration.kind} />
          <div className="min-w-0">
            <div className="truncate text-base font-medium text-[#2e2430]">
              {integration.name}
            </div>
            <div className="text-xs text-muted-foreground">
              {KIND_LABEL[integration.kind]}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={integration.status} />
          {stub && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-[#f8eed7] px-2 py-0.5 text-xs text-[#7a5818] ring-1 ring-[#b78625]/30 ring-inset"
              title="Connected without credentials. Stub mode runs the sync pipeline against a stand-in."
            >
              stub mode
            </span>
          )}
        </div>
      </header>

      <div className="px-5 py-4">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Last sync" value={lastSync} />
          <Field
            label="Last outcome"
            value={
              integration.lastSyncStatus === 'succeeded'
                ? 'Succeeded'
                : integration.lastSyncStatus === 'failed'
                  ? 'Failed'
                  : '—'
            }
            tone={
              integration.lastSyncStatus === 'failed'
                ? 'warn'
                : integration.lastSyncStatus === 'succeeded'
                  ? 'good'
                  : undefined
            }
          />
          <Field
            label="Files synced (total)"
            value={String(integration.filesSyncedTotal)}
            mono
          />
        </dl>

        {integration.lastError && (
          <div className="mt-4 rounded-md border border-[#b94f58]/30 bg-[#fdecee] px-3 py-2 text-xs text-[#8a3942]">
            <div className="mb-1 flex items-center gap-1.5 font-medium">
              <CircleAlert className="size-3.5" />
              Last error
            </div>
            <p className="font-mono break-words">{integration.lastError}</p>
          </div>
        )}

        {integration.mode === 'push' && (
          <AgentPanel integration={integration} agentInfo={agentInfo} />
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border/50 bg-[#fdf6e8]/30 px-5 py-3">
        {integration.mode === 'push' && (
          <Button
            variant="outline"
            size="sm"
            onClick={onShowAgentInfo}
            disabled={pending}
            className="gap-1.5"
          >
            Agent install
          </Button>
        )}
        {integration.mode === 'pull' && (
          <Button
            variant="outline"
            size="sm"
            onClick={onSync}
            disabled={pending || integration.status === 'disabled'}
            className="gap-1.5"
          >
            <RotateCw className={`size-3.5 ${pending ? 'animate-spin' : ''}`} />
            {pending ? 'Working...' : 'Run sync'}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => onToggle(integration.status !== 'active')}
          disabled={pending}
          className="gap-1.5"
        >
          <Power className="size-3.5" />
          {integration.status === 'active' ? 'Disable' : 'Enable'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onRemove}
          disabled={pending}
          className="gap-1.5 text-[#8a3942] hover:bg-[#fdecee] hover:text-[#8a3942]"
        >
          <Trash2 className="size-3.5" />
          Remove
        </Button>
      </footer>
    </div>
  )
}

function AgentPanel({
  integration,
  agentInfo,
}: {
  integration: IntegrationRow
  agentInfo: { integrationId: string; inboundSecret: string } | null
}) {
  const heartbeat = integration.agentLastHeartbeatAt
    ? new Date(integration.agentLastHeartbeatAt).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : 'never'

  const showInfo = agentInfo?.integrationId === integration._id

  return (
    <div className="mt-4 rounded-md border border-border/60 bg-[#fdf6e8]/40 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Agent
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] ring-1 ring-inset ${
            integration.agentStale
              ? 'bg-[#fdecee] text-[#8a3942] ring-[#b94f58]/40'
              : 'bg-[#e6f3ed] text-[#2f5d4b] ring-[#3f7c64]/40'
          }`}
        >
          <span
            className={`size-1.5 rounded-full ${
              integration.agentStale ? 'bg-[#b94f58]' : 'bg-[#3f7c64]'
            }`}
          />
          {integration.agentStale ? 'offline' : 'online'}
        </span>
      </div>
      <dl className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Last heartbeat</dt>
          <dd className="font-medium">{heartbeat}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Version</dt>
          <dd className="font-mono text-xs">
            {integration.agentVersion ?? '—'}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Host</dt>
          <dd className="truncate font-mono text-xs">
            {integration.agentHostname ?? '—'}
          </dd>
        </div>
      </dl>
      {integration.agentWatermark && (
        <div className="mt-2 text-[10px] text-muted-foreground">
          Watermark:{' '}
          <span className="font-mono">{integration.agentWatermark}</span>
        </div>
      )}
      {showInfo && (
        <div className="mt-3 rounded-md border border-[#b78625]/30 bg-[#fff8e8] p-3">
          <div className="text-[10px] font-medium tracking-wide text-[#7a5818] uppercase">
            Install token — copy into the agent's config
          </div>
          <div className="mt-2 grid gap-2 font-mono text-xs">
            <div>
              <div className="text-muted-foreground">Integration ID</div>
              <div className="break-all">{agentInfo!.integrationId}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Inbound secret</div>
              <div className="break-all">{agentInfo!.inboundSecret}</div>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-[#7a5818]">
            The secret is shown once per click. Treat it like a password —
            anyone with it can post snapshots into this tenant.
          </p>
        </div>
      )}
    </div>
  )
}

function KindBadge({ kind }: { kind: Kind }) {
  // Initials from the label, then style as a tinted square plate.
  const tone =
    kind === 'softpro_360'
      ? {
          bg: 'bg-[#e8f0f8]',
          text: 'text-[#2c4a6b]',
          ring: 'ring-[#3f668f]/30',
        }
      : kind === 'softpro_standard'
        ? {
            bg: 'bg-[#f2e7f1]',
            text: 'text-[#40233f]',
            ring: 'ring-[#593157]/30',
          }
        : kind === 'qualia'
          ? {
              bg: 'bg-[#e6f3ed]',
              text: 'text-[#2f5d4b]',
              ring: 'ring-[#3f7c64]/30',
            }
          : kind === 'resware'
            ? {
                bg: 'bg-[#fde9dc]',
                text: 'text-[#7a3d18]',
                ring: 'ring-[#c9652e]/30',
              }
            : kind === 'encompass'
              ? {
                  bg: 'bg-[#f8eed7]',
                  text: 'text-[#7a5818]',
                  ring: 'ring-[#b78625]/30',
                }
              : {
                  bg: 'bg-muted',
                  text: 'text-muted-foreground',
                  ring: 'ring-border',
                }

  const initials =
    kind === 'softpro_360'
      ? 'SP'
      : kind === 'softpro_standard'
        ? 'SS'
        : kind === 'qualia'
          ? 'Qa'
          : kind === 'resware'
            ? 'Rw'
            : kind === 'encompass'
              ? 'En'
              : 'Mk'

  return (
    <div
      className={`grid size-10 shrink-0 place-items-center rounded-md text-sm font-semibold ring-1 ring-inset ${tone.bg} ${tone.text} ${tone.ring}`}
    >
      {initials}
    </div>
  )
}

function StatusPill({ status }: { status: 'active' | 'disabled' | 'error' }) {
  const tone =
    status === 'active'
      ? {
          ring: 'ring-[#3f7c64]/40',
          text: 'text-[#2f5d4b]',
          bg: 'bg-[#e6f3ed]',
          dot: 'bg-[#3f7c64]',
          label: 'Active',
        }
      : status === 'error'
        ? {
            ring: 'ring-[#b94f58]/45',
            text: 'text-[#8a3942]',
            bg: 'bg-[#fdecee]',
            dot: 'bg-[#b94f58]',
            label: 'Error',
          }
        : {
            ring: 'ring-border',
            text: 'text-muted-foreground',
            bg: 'bg-muted',
            dot: 'bg-muted-foreground',
            label: 'Disabled',
          }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ring-1 ring-inset ${tone.ring} ${tone.text} ${tone.bg}`}
    >
      <span className={`size-1.5 rounded-full ${tone.dot}`} />
      {tone.label}
    </span>
  )
}

function Field({
  label,
  value,
  tone,
  mono,
}: {
  label: string
  value: string
  tone?: 'good' | 'warn'
  mono?: boolean
}) {
  const valueClass =
    tone === 'good'
      ? 'text-[#2f5d4b]'
      : tone === 'warn'
        ? 'text-[#8a3942]'
        : 'text-foreground/85'
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd
        className={`text-sm font-medium ${valueClass} ${mono ? 'font-numerals tabular-nums' : ''}`}
      >
        {value}
      </dd>
    </div>
  )
}

function FirstIntegrationCoach({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm ring-1 ring-foreground/5">
      <div className="grid grid-cols-1 gap-8 p-8 md:grid-cols-[1.2fr_1fr] md:p-10">
        <div>
          <div className="text-xs font-semibold text-[#b78625]">
            Get started
          </div>
          <h2 className="mt-2 font-display text-3xl leading-tight font-semibold tracking-tight text-[#40233f]">
            Connect your first system
          </h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
            An integration is a connection to a system that produces title files
            — SoftPro, Qualia, Encompass, and so on. Each connection has
            credentials, a status, and a sync history. You can also stand up a{' '}
            <strong className="font-medium text-[#40233f]">mock</strong>{' '}
            integration to try the pipeline before wiring up real credentials.
          </p>
          <Button onClick={onCreate} className="mt-5 gap-1.5">
            <Plus className="size-4" />
            New integration
          </Button>
          <div className="mt-3 text-xs text-muted-foreground">
            Takes about a minute.
          </div>
        </div>

        <ol className="flex flex-col gap-3">
          {[
            {
              n: 1,
              t: 'Pick the system',
              d: 'Choose SoftPro 360 for the standard transactional integration, or Mock for a synthetic source.',
            },
            {
              n: 2,
              t: 'Give it a display name',
              d: 'Anything descriptive — "SoftPro production" or "QA mock" — used in the UI.',
            },
            {
              n: 3,
              t: 'Add config (optional)',
              d: 'Base URL and account ID for SoftPro 360. Without these, the row runs in stub mode.',
            },
            {
              n: 4,
              t: 'Run a sync',
              d: 'Click Run sync to pull files. The history shows on each row.',
            },
          ].map((s) => (
            <li
              key={s.n}
              className="flex items-start gap-3 rounded-xl border border-border/60 bg-[#fdf6e8]/40 px-4 py-3"
            >
              <span className="font-numerals grid size-7 shrink-0 place-items-center rounded-full bg-[#40233f] text-xs font-semibold text-[#f4d48f] tabular-nums">
                {s.n}
              </span>
              <div className="min-w-0">
                <div className="text-sm font-medium text-[#40233f]">{s.t}</div>
                <div className="text-xs leading-snug text-muted-foreground">
                  {s.d}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

function NewIntegrationForm({
  onCreate,
  onCancel,
}: {
  onCreate: (args: {
    kind: Kind
    name: string
    config?: unknown
  }) => Promise<void>
  onCancel: () => void
}) {
  const [kind, setKind] = useState<Kind>('mock')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [accountId, setAccountId] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      const config = kind === 'softpro_360' ? { baseUrl, accountId } : undefined
      await onCreate({ kind, name, config })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  const comingSoon = COMING_SOON.has(kind)
  const submitDisabled = pending || !name.trim() || comingSoon

  return (
    <SectionShell
      eyebrow="New connection"
      title="Connect a system"
      description="Without credentials this runs in stub mode — useful for exercising the dashboard before the real connection is wired in."
      icon={<Plug className="size-4" />}
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCancel}
          className="gap-1.5"
        >
          <X className="size-3.5" />
          Cancel
        </Button>
      }
    >
      <form
        onSubmit={onSubmit}
        className="grid grid-cols-1 gap-5 md:grid-cols-2"
      >
        <FieldGroup
          label="System"
          hint={KIND_DESCRIPTION[kind]}
          required
          htmlFor="int-kind"
        >
          <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
            <SelectTrigger id="int-kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {KIND_LABEL[k]}
                  {COMING_SOON.has(k) ? ' — coming soon' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldGroup>

        <FieldGroup
          label="Display name"
          hint="What you'll see in the list. Keep it short."
          required
          htmlFor="int-name"
        >
          <Input
            id="int-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="SoftPro production"
          />
        </FieldGroup>

        {kind === 'softpro_360' && (
          <>
            <FieldGroup
              label="Base URL"
              hint="The endpoint of your SoftPro 360 instance. Optional — leave empty for stub mode."
              htmlFor="int-base"
            >
              <Input
                id="int-base"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://protrust.example/api"
                className="font-numerals"
              />
            </FieldGroup>
            <FieldGroup
              label="Account ID"
              hint="Your tenant identifier on the SoftPro side."
              htmlFor="int-account"
            >
              <Input
                id="int-account"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder="acme-titles"
                className="font-numerals"
              />
            </FieldGroup>
          </>
        )}

        {comingSoon && (
          <div className="md:col-span-2">
            <div className="rounded-md border border-[#b78625]/35 bg-[#fdf6e8] px-3 py-2 text-sm text-[#7a5818]">
              <div className="mb-1 flex items-center gap-1.5 font-medium">
                <CircleAlert className="size-3.5" />
                Adapter not implemented yet
              </div>
              <p className="text-xs leading-snug">
                You can reserve the row, but syncs will fail until the transport
                is wired in. Pick another system to continue.
              </p>
            </div>
          </div>
        )}

        {error && (
          <p className="rounded-md border border-[#b94f58]/30 bg-[#fdecee] px-3 py-2 text-sm text-[#8a3942] md:col-span-2">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 md:col-span-2">
          <div className="text-xs text-muted-foreground">
            <span className="text-[#b94f58]">*</span> required.{' '}
            {!name.trim() && 'Add a display name. '}
            {comingSoon && "Pick a system that's available."}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitDisabled} className="gap-1.5">
              <CheckCircle2 className="size-4" />
              {pending ? 'Creating...' : 'Create integration'}
            </Button>
          </div>
        </div>
      </form>
    </SectionShell>
  )
}

function FieldGroup({
  label,
  hint,
  htmlFor,
  required,
  children,
}: {
  label: string
  hint?: string
  htmlFor?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-sm font-medium text-[#40233f]">
        {label}
        {required && (
          <span className="ml-1 text-[#b94f58]" aria-hidden>
            *
          </span>
        )}
      </Label>
      {children}
      {hint && (
        <span className="text-xs leading-snug text-muted-foreground">
          {hint}
        </span>
      )}
    </div>
  )
}
