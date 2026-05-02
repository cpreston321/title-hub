import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronLeft,
  CircleAlert,
  Copy,
  Layers,
  Plug,
  Plus,
  Power,
  RotateCw,
  Sparkles,
  Trash2,
  X,
  Zap,
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
import { Loading } from '@/components/loading'
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
  | 'email_inbound'
  | 'mock'

const KIND_LABEL: Record<Kind, string> = {
  softpro_360: 'SoftPro 360',
  softpro_standard: 'SoftPro Standard (direct)',
  qualia: 'Qualia',
  resware: 'ResWare',
  encompass: 'Encompass',
  email_inbound: 'Inbound mail',
  mock: 'Mock (testing)',
}

const KIND_DESCRIPTION: Record<Kind, string> = {
  softpro_360:
    "SoftPro's 360 transactional integration. Pulls files via the standard 360 transport.",
  softpro_standard:
    'Direct SoftPro Select/Standard connection. A customer-side agent watches ProForm and pushes file snapshots — no inbound network access required.',
  qualia: 'Qualia Connect — coming soon.',
  resware: 'ResWare title production — coming soon.',
  encompass: 'Encompass loan files — coming soon.',
  email_inbound:
    'A unique forwarding address for this tenant. Auto-forward agency mail to it; we classify each message and pull attachments onto the right file.',
  mock: 'A fake source that produces synthetic files. Use this to try the sync pipeline end-to-end without real credentials.',
}

const SUPPORTED_KINDS: Array<Kind> = [
  'softpro_360',
  'softpro_standard',
  'email_inbound',
  'mock',
]
const COMING_SOON: ReadonlySet<Kind> = new Set()

function IntegrationsAdminPage() {
  const current = useQuery(convexQuery(api.tenants.current, {}))
  const integrations = useQuery(convexQuery(api.integrations.list, {}))
  const create = useConvexMutation(api.integrations.create)
  const setEnabled = useConvexMutation(api.integrations.setEnabled)
  const remove = useConvexMutation(api.integrations.remove)
  const runSync = useConvexMutation(api.integrations.runSync)
  const agentInstallInfo = useConvexMutation(api.integrations.agentInstallInfo)
  const generateInstallToken = useConvexMutation(
    api.integrations.generateAgentInstallToken,
  )

  const [showForm, setShowForm] = useState(false)
  const [prefillKind, setPrefillKind] = useState<Kind | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Per-integration UI state: an "Agent install" panel can show either
  // the legacy raw-TOML reveal (agentInfo) OR a freshly-issued one-time
  // install token (installToken). The token is preferred — admins should
  // hand the install command to the agency, not the long-lived secret.
  const [agentInfo, setAgentInfo] = useState<{
    integrationId: string
    inboundSecret: string
  } | null>(null)
  const [installToken, setInstallToken] = useState<{
    integrationId: string
    token: string
    expiresAt: number
    prefix: string
  } | null>(null)

  const onGenerateInstallToken = async (id: Id<'integrations'>) => {
    setPending(id)
    setError(null)
    try {
      const issued = await generateInstallToken({ integrationId: id })
      setAgentInfo(null)
      setInstallToken({
        integrationId: id,
        token: issued.token,
        expiresAt: issued.expiresAt,
        prefix: issued.prefix,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

  const onShowAgentInfo = async (id: Id<'integrations'>) => {
    setPending(id)
    setError(null)
    try {
      const info = await agentInstallInfo({ integrationId: id })
      setInstallToken(null)
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
        <Loading block size="lg" label="Patching in" />
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
            onClick={() => {
              if (showForm) {
                setShowForm(false)
                setPrefillKind(null)
              } else {
                setShowForm(true)
              }
            }}
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
        <PageHeader />

        {error && (
          <p className="rounded-md border border-[#b94f58]/30 bg-[#fdecee] px-3 py-2 text-sm text-[#8a3942]">
            {error}
          </p>
        )}

        {list.length > 0 && <KpiStrip stats={stats} />}

        {showForm ? (
          <NewIntegrationForm
            initialKind={prefillKind ?? 'mock'}
            onCreate={async (args) => {
              await create(args)
              setShowForm(false)
              setPrefillKind(null)
            }}
            onCancel={() => {
              setShowForm(false)
              setPrefillKind(null)
            }}
          />
        ) : list.length === 0 ? (
          <FirstIntegrationCoach
            onConnect={(kind) => {
              setPrefillKind(kind)
              setShowForm(true)
            }}
          />
        ) : (
          <>
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
                      onHideAgentInfo={() => setAgentInfo(null)}
                      onGenerateInstallToken={() =>
                        onGenerateInstallToken(i._id as Id<'integrations'>)
                      }
                      onClearInstallToken={() => setInstallToken(null)}
                      agentInfo={agentInfo}
                      installToken={installToken}
                    />
                  </li>
                ))}
              </ul>
            </SectionShell>

            <SectionShell
              eyebrow="Section · marketplace"
              title="Add another connection"
              description="Every supported source. Click Connect to prefill the new-integration form with the kind you want."
              icon={<Layers className="size-4" />}
            >
              <MarketplaceGrid
                connectedByKind={countByKind(list)}
                onConnect={(kind) => {
                  setPrefillKind(kind)
                  setShowForm(true)
                }}
              />
            </SectionShell>
          </>
        )}
      </div>
    </AppShell>
  )
}

// Kinds that have an actual adapter today. Coming-soon kinds are filtered
// out of the marketplace until they're implemented.
function countByKind(list: ReadonlyArray<IntegrationRow>): Record<Kind, number> {
  const out: Partial<Record<Kind, number>> = {}
  for (const i of list) {
    out[i.kind] = (out[i.kind] ?? 0) + 1
  }
  return out as Record<Kind, number>
}

function PageHeader() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl leading-[1] font-semibold tracking-tight text-[#40233f] md:text-5xl">
            Integrations
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Connect external order systems — SoftPro, Qualia, Encompass — and
            inbound mail. Each connection feeds files and documents into this
            tenant. Use a{' '}
            <strong className="font-medium text-[#40233f]">mock</strong>{' '}
            integration to exercise the pipeline before wiring real credentials.
          </p>
        </div>
      </div>
    </div>
  )
}

function KpiStrip({
  stats,
}: {
  stats: { total: number; active: number; error: number; syncedTotal: number }
}) {
  const tiles: ReadonlyArray<{
    label: string
    value: number
    caption: string
    icon: React.ReactNode
    accent: string
  }> = [
    {
      label: 'Connected',
      value: stats.total,
      caption: stats.total === 1 ? '1 source wired in' : 'sources wired in',
      icon: <Plug className="size-3.5" />,
      accent: 'text-[#40233f]',
    },
    {
      label: 'Active',
      value: stats.active,
      caption: 'flowing into the tenant',
      icon: <Zap className="size-3.5" />,
      accent: 'text-[#2f5d4b]',
    },
    {
      label: 'Errors',
      value: stats.error,
      caption:
        stats.error > 0
          ? 'attention needed'
          : 'every adapter healthy',
      icon: <CircleAlert className="size-3.5" />,
      accent: stats.error > 0 ? 'text-[#8a3942]' : 'text-[#7a5818]',
    },
    {
      label: 'Files synced',
      value: stats.syncedTotal,
      caption: 'lifetime, all sources',
      icon: <Sparkles className="size-3.5" />,
      accent: 'text-[#2c4a6b]',
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map((t) => (
        <div
          key={t.label}
          className="flex flex-col gap-1 rounded-2xl border border-border/70 bg-card px-4 py-3 shadow-sm ring-1 ring-foreground/5"
        >
          <div
            className={`flex items-center gap-1.5 text-xs font-medium ${t.accent}`}
          >
            {t.icon}
            {t.label}
          </div>
          <div className="font-display text-2xl leading-none font-semibold tabular-nums text-[#40233f]">
            {String(t.value).padStart(2, '0')}
          </div>
          <div className="text-xs text-muted-foreground">{t.caption}</div>
        </div>
      ))}
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
  config: unknown
  hasCredentials: boolean
  lastSyncAt: number | null
  lastSyncStatus: 'succeeded' | 'failed' | null
  lastError: string | null
  filesSyncedTotal: number
  createdAt: number
  mode: 'pull' | 'push' | 'inbound'
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
  onHideAgentInfo,
  onGenerateInstallToken,
  onClearInstallToken,
  agentInfo,
  installToken,
}: {
  integration: IntegrationRow
  pending: boolean
  onToggle: (enabled: boolean) => void
  onSync: () => void
  onRemove: () => void
  onShowAgentInfo: () => void
  onHideAgentInfo: () => void
  onGenerateInstallToken: () => void
  onClearInstallToken: () => void
  agentInfo: { integrationId: string; inboundSecret: string } | null
  installToken: {
    integrationId: string
    token: string
    expiresAt: number
    prefix: string
  } | null
}) {
  const lastSync = integration.lastSyncAt
    ? new Date(integration.lastSyncAt).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : 'never'
  const stub =
    !integration.hasCredentials &&
    integration.kind !== 'mock' &&
    integration.mode !== 'inbound'

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
        {integration.mode !== 'inbound' && (
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
        )}

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
          <AgentPanel
            integration={integration}
            agentInfo={agentInfo}
            installToken={installToken}
            onHideAgentInfo={onHideAgentInfo}
            onClearInstallToken={onClearInstallToken}
          />
        )}

        {integration.mode === 'inbound' && (
          <EmailPanel integration={integration} />
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border/50 bg-[#fdf6e8]/30 px-5 py-3">
        {integration.mode === 'push' && (
          <>
            <Button
              size="sm"
              onClick={onGenerateInstallToken}
              disabled={pending}
              className="gap-1.5"
            >
              Generate install command
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onShowAgentInfo}
              disabled={pending}
              className="gap-1.5"
              title="Reveal the long-lived inbound secret. Use only for offline / airgapped installs — prefer the install command."
            >
              Show secret
            </Button>
          </>
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
  installToken,
  onHideAgentInfo,
  onClearInstallToken,
}: {
  integration: IntegrationRow
  agentInfo: { integrationId: string; inboundSecret: string } | null
  installToken: {
    integrationId: string
    token: string
    expiresAt: number
    prefix: string
  } | null
  onHideAgentInfo: () => void
  onClearInstallToken: () => void
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
      {installToken?.integrationId === integration._id && (
        <InstallCommandPanel
          token={installToken.token}
          prefix={installToken.prefix}
          expiresAt={installToken.expiresAt}
          onClear={onClearInstallToken}
        />
      )}
      {showInfo && (
        <AgentInstallToken
          integrationId={agentInfo!.integrationId}
          inboundSecret={agentInfo!.inboundSecret}
          onHide={onHideAgentInfo}
        />
      )}
    </div>
  )
}

function InstallCommandPanel({
  token,
  prefix,
  expiresAt,
  onClear,
}: {
  token: string
  prefix: string
  expiresAt: number
  onClear: () => void
}) {
  const baseUrl = (import.meta.env.VITE_CONVEX_SITE_URL ?? '').toString()
  const psOneLiner = `iwr ${baseUrl}/agent/install.ps1?t=${token} -UseBasicParsing | iex`
  const shOneLiner = `curl -fsSL "${baseUrl}/agent/install.sh?t=${token}" | bash`
  const fallbackCli = `agent install --token ${token} --server ${baseUrl}`

  const [tab, setTab] = useState<'windows' | 'unix' | 'manual'>('windows')
  const command =
    tab === 'windows' ? psOneLiner : tab === 'unix' ? shOneLiner : fallbackCli

  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now())

  // Tick once a second so the countdown stays live without re-querying.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000))
  const expired = remaining === 0
  const min = Math.floor(remaining / 60)
  const sec = remaining % 60
  const countdown = expired
    ? 'expired — generate a new one'
    : `${min}:${sec.toString().padStart(2, '0')} until expiry`

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked */
    }
  }

  const tabs: ReadonlyArray<{
    id: 'windows' | 'unix' | 'manual'
    label: string
    hint: string
  }> = [
    {
      id: 'windows',
      label: 'Windows (PowerShell)',
      hint: 'Downloads the signed agent.exe, installs into %ProgramData%\\TitleHubAgent, and registers the config.',
    },
    {
      id: 'unix',
      label: 'macOS / Linux',
      hint: 'For dev/testing — agencies typically run the agent on Windows.',
    },
    {
      id: 'manual',
      label: 'Manual (have the binary)',
      hint: 'Skip the bootstrap script. Use this if you already built or downloaded the agent and just need to write the config.',
    },
  ]

  return (
    <div className="mt-3 rounded-md border border-[#3f7c64]/40 bg-[#e9f3ed] p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[10px] font-medium tracking-wide text-[#2f5d4b] uppercase">
          One-line install — paste on the agent host
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={onCopy}
            disabled={expired}
            className="h-7 gap-1.5 px-2 text-xs"
          >
            {copied ? (
              <>
                <Check className="size-3" />
                Copied
              </>
            ) : (
              <>
                <Copy className="size-3" />
                Copy
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            className="h-7 px-2 text-xs"
          >
            Hide
          </Button>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-1 rounded-full bg-card p-1 ring-1 ring-[#3f7c64]/30">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-full px-2.5 py-0.5 text-[11px] transition ${
              tab === t.id
                ? 'bg-[#2f5d4b] text-white shadow-sm'
                : 'text-[#2f5d4b] hover:bg-[#e9f3ed]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <pre className="mt-2 overflow-x-auto rounded bg-[#40233f] p-3 font-mono text-[11px] leading-relaxed text-[#f4d48f]">
        <code>{command}</code>
      </pre>
      <p className="mt-1 text-[11px] text-[#2f5d4b]/80">
        {tabs.find((t) => t.id === tab)?.hint}
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <span className="text-[#2f5d4b]">
          Token <span className="font-mono">{prefix}…</span> · {countdown}
        </span>
        <span className="text-[#2f5d4b]/70">
          Single-use. Generate a new one if you need to reinstall.
        </span>
      </div>
      {!baseUrl && (
        <p className="mt-2 text-[11px] text-[#8a3942]">
          <strong>Note:</strong> <code>VITE_CONVEX_SITE_URL</code> isn't set in
          this build, so the install URL is blank. Fill it in manually with
          your deployment's <code>.convex.site</code> URL.
        </p>
      )}
    </div>
  )
}

function AgentInstallToken({
  integrationId,
  inboundSecret,
  onHide,
}: {
  integrationId: string
  inboundSecret: string
  onHide: () => void
}) {
  const baseUrl = (import.meta.env.VITE_CONVEX_SITE_URL ?? '').toString()

  // Matches agent/agent.example.toml — paste-as-is into agent.toml.
  const tomlBlock = [
    `# title-hub-agent config — generated ${new Date().toISOString()}`,
    `base_url = "${baseUrl}"`,
    `integration_id = "${integrationId}"`,
    `inbound_secret = "${inboundSecret}"`,
    `agent_version = "0.1.0"`,
  ].join('\n')

  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(tomlBlock)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Browser blocked clipboard — leave the textarea selectable instead.
    }
  }

  return (
    <div className="mt-3 rounded-md border border-[#b78625]/30 bg-[#fff8e8] p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] font-medium tracking-wide text-[#7a5818] uppercase">
          Install token — paste into the agent's <code>agent.toml</code>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={onCopy}
            className="h-7 gap-1.5 px-2 text-xs"
          >
            {copied ? (
              <>
                <Check className="size-3" />
                Copied
              </>
            ) : (
              <>
                <Copy className="size-3" />
                Copy
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onHide}
            className="h-7 px-2 text-xs"
          >
            Hide
          </Button>
        </div>
      </div>
      <pre className="mt-2 overflow-x-auto rounded bg-[#40233f] p-3 font-mono text-[11px] leading-relaxed text-[#f4d48f]">
        <code>{tomlBlock}</code>
      </pre>
      {!baseUrl && (
        <p className="mt-2 text-[11px] text-[#8a3942]">
          <strong>Note:</strong> <code>VITE_CONVEX_SITE_URL</code> isn't set in
          this build, so <code>base_url</code> is blank. Fill it in manually
          with your deployment's <code>.convex.site</code> URL.
        </p>
      )}
      <p className="mt-2 text-[11px] text-[#7a5818]">
        The secret is shown once per click. Treat it like a password — anyone
        with it can post snapshots into this tenant.
      </p>
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
              : kind === 'email_inbound'
                ? {
                    bg: 'bg-[#e8f0f8]',
                    text: 'text-[#2c4a6b]',
                    ring: 'ring-[#3f668f]/30',
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
              : kind === 'email_inbound'
                ? '@'
                : 'Mk'

  return (
    <div
      className={`grid size-10 shrink-0 place-items-center rounded-md text-sm font-semibold ring-1 ring-inset ${tone.bg} ${tone.text} ${tone.ring}`}
    >
      {initials}
    </div>
  )
}

// ─── Email-inbound setup panel ──────────────────────────────────────────
//
// One-screen onboarding for the email_inbound integration. Surfaces:
//   1. The unique forwarding address the agency should auto-forward to.
//      Until the Postmark Lambda is wired in, we show a placeholder that
//      includes the integration id so the address is stable across renames.
//   2. A direct webhook URL processors can curl during development.
//   3. Setup tabs for Gmail / Outlook / Manual forwarding.
//
// The HMAC inboundSecret is NOT shown here — agencies don't operate the
// re-signer; we do. Use the agent-style "reveal" pattern in a future
// internal-tools section if that ever changes.

function EmailPanel({ integration }: { integration: IntegrationRow }) {
  const baseUrl = (import.meta.env.VITE_CONVEX_SITE_URL ?? '').toString()
  const config = integration.config as
    | { forwardAddressLocalPart?: string }
    | null
    | undefined
  const localPart = config?.forwardAddressLocalPart ?? integration._id
  const forwardAddress = `mail-${localPart}@inbound.titlehub.app`
  const webhookUrl = baseUrl
    ? `${baseUrl}/integrations/email/inbound?id=${integration._id}`
    : `<your .convex.site URL>/integrations/email/inbound?id=${integration._id}`

  return (
    <div className="mt-4 rounded-md border border-border/60 bg-[#e8f0f8]/40 px-4 py-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Inbox setup
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-[#e8f0f8] px-2 py-0.5 text-[10px] font-medium text-[#2c4a6b] ring-1 ring-inset ring-[#3f668f]/30">
          Webhook delivery
        </span>
      </div>

      <CopyableField
        label="Forwarding address"
        value={forwardAddress}
        helper="Auto-forward agency mail to this address. We classify each message and pull attachments onto the matched file."
      />

      <CopyableField
        label="Direct webhook URL"
        value={webhookUrl}
        mono
        helper="Used by the Postmark re-signer (or curl during testing). HMAC-signed with the per-integration inboundSecret."
      />

      <ForwardingHowTo address={forwardAddress} />

      <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
        Until the Postmark inbound provider is provisioned for your
        deployment, the address above is illustrative. Test the pipeline
        end-to-end with{' '}
        <code className="rounded bg-card px-1 py-0.5 font-mono text-[10px]">
          bun run admin simulate-email {(integration as { tenantSlug?: string }).tenantSlug ?? '<tenant-slug>'}
        </code>
        .
      </p>
    </div>
  )
}

function CopyableField({
  label,
  value,
  helper,
  mono,
}: {
  label: string
  value: string
  helper?: string
  mono?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked */
    }
  }
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-[#2c4a6b]">
          {label}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCopy}
          className="h-6 gap-1 px-2 text-[11px] text-[#2c4a6b] hover:bg-[#e8f0f8]"
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          {copied ? (
            <>
              <Check className="size-3" />
              Copied
            </>
          ) : (
            <>
              <Copy className="size-3" />
              Copy
            </>
          )}
        </Button>
      </div>
      <div
        className={`overflow-x-auto rounded-md border border-[#3f668f]/20 bg-card px-3 py-2 text-sm text-[#2c4a6b] ${
          mono ? 'font-mono text-[12px]' : 'font-numerals'
        }`}
      >
        {value}
      </div>
      {helper && (
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          {helper}
        </p>
      )}
    </div>
  )
}

function ForwardingHowTo({ address }: { address: string }) {
  const [tab, setTab] = useState<'gmail' | 'outlook' | 'manual'>('gmail')
  const tabs: ReadonlyArray<{ id: typeof tab; label: string }> = [
    { id: 'gmail', label: 'Gmail / Workspace' },
    { id: 'outlook', label: 'Outlook 365' },
    { id: 'manual', label: 'Plain SMTP' },
  ]

  return (
    <div className="mt-3 rounded-md border border-[#3f668f]/30 bg-card/80 p-3">
      <div className="mb-2 flex items-center gap-1 rounded-full bg-[#e8f0f8]/50 p-1 ring-1 ring-[#3f668f]/20">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-full px-2.5 py-0.5 text-[11px] transition ${
              tab === t.id
                ? 'bg-[#2c4a6b] text-white shadow-sm'
                : 'text-[#2c4a6b] hover:bg-[#e8f0f8]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'gmail' && (
        <ol className="flex flex-col gap-1.5 text-[12px] leading-snug text-foreground/85">
          <Step n={1}>
            Settings → Forwarding and POP/IMAP → <strong>Add a forwarding address</strong>{' '}
            and paste{' '}
            <code className="rounded bg-muted px-1 font-mono text-[11px]">
              {address}
            </code>
            . Verify via the confirmation email Gmail sends.
          </Step>
          <Step n={2}>
            Settings → Filters and Blocked Addresses →{' '}
            <strong>Create a new filter</strong>. Set criteria (e.g. "Has the
            words: file" or "From: lender.com"), then click{' '}
            <em>Create filter with this search</em>.
          </Step>
          <Step n={3}>
            Check <strong>Forward it to: {address}</strong> and Apply. New
            mail matching the filter starts arriving in your inbox tab here.
          </Step>
        </ol>
      )}

      {tab === 'outlook' && (
        <ol className="flex flex-col gap-1.5 text-[12px] leading-snug text-foreground/85">
          <Step n={1}>
            Settings → <strong>Mail → Rules → Add new rule</strong>.
          </Step>
          <Step n={2}>
            Add a condition (e.g. <em>Subject includes "file"</em> or{' '}
            <em>Sender is lender.com</em>) and the action{' '}
            <strong>Forward to {address}</strong>.
          </Step>
          <Step n={3}>
            Save. Microsoft 365 begins forwarding immediately — no
            confirmation email required.
          </Step>
        </ol>
      )}

      {tab === 'manual' && (
        <ol className="flex flex-col gap-1.5 text-[12px] leading-snug text-foreground/85">
          <Step n={1}>
            Configure your mail server's redirect / .forward to copy mail to{' '}
            <code className="rounded bg-muted px-1 font-mono text-[11px]">
              {address}
            </code>
            .
          </Step>
          <Step n={2}>
            Make sure your SPF / DMARC records are not strict on the From
            address — forwarders sometimes break alignment, which Postmark
            handles but can affect deliverability.
          </Step>
          <Step n={3}>
            Send a test message. The first one arrives within 30s and shows
            up in your Mail tab here.
          </Step>
        </ol>
      )}
    </div>
  )
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="font-numerals mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-[#2c4a6b] text-[10px] font-semibold text-white tabular-nums">
        {n}
      </span>
      <span>{children}</span>
    </li>
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

function FirstIntegrationCoach({
  onConnect,
}: {
  onConnect: (kind: Kind) => void
}) {
  return (
    <div className="flex flex-col gap-6">
      <article className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm ring-1 ring-foreground/5">
        <div className="grid grid-cols-1 gap-6 p-6 md:grid-cols-[1.4fr_1fr] md:gap-8 md:p-8">
          <div>
            <div className="text-xs font-semibold text-[#b78625]">
              Get started
            </div>
            <h2 className="mt-2 font-display text-3xl leading-tight font-semibold tracking-tight text-[#40233f]">
              Pick a source to connect
            </h2>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
              An integration is one connection to a system that produces title
              files — SoftPro, inbound mail, Qualia, Encompass, and so on. Pick
              one from the marketplace below to start, or stand up a{' '}
              <strong className="font-medium text-[#40233f]">mock</strong>{' '}
              source to exercise the pipeline first.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 rounded-full bg-[#fdf6e8] px-2 py-0.5 ring-1 ring-[#b78625]/30 ring-inset text-[#7a5818]">
                <Sparkles className="size-3" />
                Takes about a minute
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-[#e8f0f8] px-2 py-0.5 ring-1 ring-[#3f668f]/30 ring-inset text-[#2c4a6b]">
                <Plug className="size-3" />
                No credentials? Stub mode works
              </span>
            </div>
          </div>

          <ol className="flex flex-col gap-2">
            {[
              { n: 1, t: 'Pick the source', d: 'Click Connect on a tile.' },
              {
                n: 2,
                t: 'Name it',
                d: '"SoftPro production", "QA mock", anything descriptive.',
              },
              {
                n: 3,
                t: 'Wire credentials (optional)',
                d: 'Base URL + account ID for SoftPro 360. Skip it for stub mode.',
              },
              {
                n: 4,
                t: 'Run a sync or send a test message',
                d: 'Each kind shows the right next step on its card.',
              },
            ].map((s) => (
              <li
                key={s.n}
                className="flex items-start gap-3 rounded-xl border border-border/60 bg-[#fdf6e8]/40 px-3.5 py-2.5"
              >
                <span className="font-numerals grid size-6 shrink-0 place-items-center rounded-full bg-[#40233f] text-[10px] font-semibold text-[#f4d48f] tabular-nums">
                  {s.n}
                </span>
                <div className="min-w-0">
                  <div className="text-xs font-medium text-[#40233f]">
                    {s.t}
                  </div>
                  <div className="text-[11px] leading-snug text-muted-foreground">
                    {s.d}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </article>

      <SectionShell
        eyebrow="Section · marketplace"
        title="Available sources"
        description="One tile per kind. Click Connect to open the new-integration form pre-set to that source."
        icon={<Layers className="size-4" />}
      >
        <MarketplaceGrid
          connectedByKind={{} as Record<Kind, number>}
          onConnect={onConnect}
        />
      </SectionShell>
    </div>
  )
}

// Marketplace grid: every supported adapter as a tile. Tiles for kinds
// already configured surface a small "connected · N" caption so the user
// knows they can add a second of that kind (e.g. two SoftPro orgs).
function MarketplaceGrid({
  connectedByKind,
  onConnect,
}: {
  connectedByKind: Record<Kind, number>
  onConnect: (kind: Kind) => void
}) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {SUPPORTED_KINDS.map((k) => (
        <li key={k}>
          <MarketplaceTile
            kind={k}
            existing={connectedByKind[k] ?? 0}
            onConnect={() => onConnect(k)}
          />
        </li>
      ))}
    </ul>
  )
}

function MarketplaceTile({
  kind,
  existing,
  onConnect,
}: {
  kind: Kind
  existing: number
  onConnect: () => void
}) {
  const comingSoon = COMING_SOON.has(kind)
  const tone = kindTone(kind)
  return (
    <button
      type="button"
      onClick={comingSoon ? undefined : onConnect}
      disabled={comingSoon}
      aria-label={`Connect ${KIND_LABEL[kind]}`}
      className={`group/tile flex h-full w-full flex-col gap-3 rounded-xl border border-border/70 bg-card p-4 text-left ring-1 ring-foreground/5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#593157]/40 ${
        comingSoon
          ? 'cursor-not-allowed opacity-60'
          : 'hover:-translate-y-0.5 hover:border-[#593157]/30 hover:shadow-md'
      }`}
    >
      <div className="flex items-start gap-3">
        <KindBadge kind={kind} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-display text-base font-semibold tracking-tight text-[#40233f]">
              {KIND_LABEL[kind]}
            </span>
            {existing > 0 && (
              <span className={`font-numerals text-[10px] tabular-nums ${tone.text}`}>
                connected · {existing}
              </span>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">
            {KIND_DESCRIPTION[kind]}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between">
        {comingSoon ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-[#fdf6e8] px-2 py-0.5 text-[10px] font-medium text-[#7a5818] ring-1 ring-[#b78625]/30 ring-inset">
            Coming soon
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
            {kindModeHint(kind)}
          </span>
        )}
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
            comingSoon
              ? 'bg-muted text-muted-foreground'
              : `${tone.bg} ${tone.text} ring-1 ring-inset ${tone.ring} group-hover/tile:bg-[#40233f] group-hover/tile:text-[#f6e8d9] group-hover/tile:ring-transparent`
          }`}
        >
          {existing > 0 ? 'Connect another' : 'Connect'}
          <ArrowRight className="size-3" />
        </span>
      </div>
    </button>
  )
}

function kindTone(kind: Kind): {
  bg: string
  text: string
  ring: string
} {
  switch (kind) {
    case 'softpro_360':
      return {
        bg: 'bg-[#e8f0f8]',
        text: 'text-[#2c4a6b]',
        ring: 'ring-[#3f668f]/30',
      }
    case 'softpro_standard':
      return {
        bg: 'bg-[#f2e7f1]',
        text: 'text-[#40233f]',
        ring: 'ring-[#593157]/30',
      }
    case 'qualia':
      return {
        bg: 'bg-[#e6f3ed]',
        text: 'text-[#2f5d4b]',
        ring: 'ring-[#3f7c64]/30',
      }
    case 'resware':
      return {
        bg: 'bg-[#fde9dc]',
        text: 'text-[#7a3d18]',
        ring: 'ring-[#c9652e]/30',
      }
    case 'encompass':
      return {
        bg: 'bg-[#f8eed7]',
        text: 'text-[#7a5818]',
        ring: 'ring-[#b78625]/30',
      }
    case 'email_inbound':
      return {
        bg: 'bg-[#e8f0f8]',
        text: 'text-[#2c4a6b]',
        ring: 'ring-[#3f668f]/30',
      }
    default:
      return {
        bg: 'bg-muted',
        text: 'text-muted-foreground',
        ring: 'ring-border',
      }
  }
}

function kindModeHint(kind: Kind): string {
  switch (kind) {
    case 'softpro_360':
    case 'qualia':
    case 'resware':
    case 'encompass':
      return 'Pull · runs on a schedule'
    case 'softpro_standard':
      return 'Push · customer-side agent'
    case 'email_inbound':
      return 'Webhook · forwarded mail'
    case 'mock':
      return 'Synthetic · for testing'
    default:
      return ''
  }
}

function NewIntegrationForm({
  initialKind,
  onCreate,
  onCancel,
}: {
  initialKind?: Kind
  onCreate: (args: {
    kind: Kind
    name: string
    config?: unknown
  }) => Promise<void>
  onCancel: () => void
}) {
  const [kind, setKind] = useState<Kind>(initialKind ?? 'mock')
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
