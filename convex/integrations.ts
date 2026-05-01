import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { recordAudit } from './lib/audit'
import { requireRole, requireTenant } from './lib/tenant'
import type { Doc, Id } from './_generated/dataModel'

const integrationKind = v.union(
  v.literal('softpro_360'),
  v.literal('softpro_standard'),
  v.literal('qualia'),
  v.literal('resware'),
  v.literal('encompass'),
  v.literal('mock')
)

function newSecret(): string {
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

// Push-mode integration kinds. Mirrors `Adapter.mode === "push"` in the
// registry but kept here as a literal so query-runtime code can branch
// without importing the adapter modules.
const PUSH_MODE_KINDS = new Set<Doc<'integrations'>['kind']>([
  'softpro_standard',
])

// Heartbeat older than this is considered stale — the dashboard renders
// the agent as offline, and a sync attempt will note the staleness.
const HEARTBEAT_STALE_AFTER_MS = 5 * 60_000

// Public surface for the integration on a domain row. Strips inboundSecret
// (the HMAC secret never leaves the server unless the admin explicitly
// requests it via `revealInboundSecret`).
function publicShape(row: Doc<'integrations'>) {
  const isPush = PUSH_MODE_KINDS.has(row.kind)
  const heartbeatAt = row.agentLastHeartbeatAt ?? null
  const agentStale =
    isPush &&
    (heartbeatAt === null ||
      Date.now() - heartbeatAt > HEARTBEAT_STALE_AFTER_MS)
  return {
    _id: row._id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    config: row.config,
    hasCredentials: !!row.credentialsToken,
    cursor: row.cursor ?? null,
    lastSyncAt: row.lastSyncAt ?? null,
    lastSyncStatus: row.lastSyncStatus ?? null,
    lastError: row.lastError ?? null,
    filesSyncedTotal: row.filesSyncedTotal,
    createdAt: row.createdAt,
    mode: isPush ? ('push' as const) : ('pull' as const),
    agentLastHeartbeatAt: heartbeatAt,
    agentVersion: row.agentVersion ?? null,
    agentHostname: row.agentHostname ?? null,
    agentWatermark: row.agentWatermark ?? null,
    agentStale,
  }
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)
    const rows = await ctx.db
      .query('integrations')
      .withIndex('by_tenant', (q) => q.eq('tenantId', tc.tenantId))
      .order('desc')
      .take(50)
    return rows.map(publicShape)
  },
})

export const get = query({
  args: { integrationId: v.id('integrations') },
  handler: async (ctx, { integrationId }) => {
    const tc = await requireTenant(ctx)
    const row = await ctx.db.get(integrationId)
    if (!row || row.tenantId !== tc.tenantId) {
      throw new ConvexError('INTEGRATION_NOT_FOUND')
    }

    const recentRuns = await ctx.db
      .query('integrationSyncRuns')
      .withIndex('by_tenant_integration', (q) =>
        q.eq('tenantId', tc.tenantId).eq('integrationId', integrationId)
      )
      .order('desc')
      .take(10)

    return {
      integration: publicShape(row),
      recentRuns,
    }
  },
})

export const create = mutation({
  args: {
    kind: integrationKind,
    name: v.string(),
    config: v.optional(v.any()),
    credentialsToken: v.optional(v.string()),
  },
  handler: async (ctx, { kind, name, config, credentialsToken }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner', 'admin')

    if (name.trim() === '') throw new ConvexError('INVALID_NAME')

    // Validate the credentials token (if provided) belongs to this tenant.
    if (credentialsToken) {
      const tok = await ctx.db
        .query('npiSecrets')
        .withIndex('by_tenant_token', (q) =>
          q.eq('tenantId', tc.tenantId).eq('token', credentialsToken)
        )
        .unique()
      if (!tok) throw new ConvexError('CREDENTIALS_TOKEN_NOT_FOUND')
      if (tok.fieldKind !== 'account') {
        throw new ConvexError('CREDENTIALS_TOKEN_WRONG_KIND')
      }
    }

    const id = await ctx.db.insert('integrations', {
      tenantId: tc.tenantId,
      kind,
      name: name.trim(),
      status: 'active',
      config: config ?? null,
      credentialsToken,
      inboundSecret: newSecret(),
      filesSyncedTotal: 0,
      createdAt: Date.now(),
    })

    await recordAudit(ctx, tc, 'integration.created', 'integration', id, {
      kind,
      name: name.trim(),
      hasCredentials: !!credentialsToken,
    })

    return { integrationId: id }
  },
})

export const setEnabled = mutation({
  args: { integrationId: v.id('integrations'), enabled: v.boolean() },
  handler: async (ctx, { integrationId, enabled }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner', 'admin')
    const row = await ctx.db.get(integrationId)
    if (!row || row.tenantId !== tc.tenantId) {
      throw new ConvexError('INTEGRATION_NOT_FOUND')
    }
    await ctx.db.patch(integrationId, {
      status: enabled ? 'active' : 'disabled',
    })
    await recordAudit(
      ctx,
      tc,
      enabled ? 'integration.enabled' : 'integration.disabled',
      'integration',
      integrationId,
      {}
    )
    return { ok: true }
  },
})

export const remove = mutation({
  args: { integrationId: v.id('integrations') },
  handler: async (ctx, { integrationId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner', 'admin')
    const row = await ctx.db.get(integrationId)
    if (!row || row.tenantId !== tc.tenantId) {
      throw new ConvexError('INTEGRATION_NOT_FOUND')
    }

    // Sync runs are kept for audit; deleting the integration just makes
    // them orphan-readable. (Tenant erasure already covers full deletion.)
    await ctx.db.delete(integrationId)
    await recordAudit(
      ctx,
      tc,
      'integration.removed',
      'integration',
      integrationId,
      {
        kind: row.kind,
        name: row.name,
      }
    )
    return { ok: true }
  },
})

// Reveal the inbound HMAC secret. Admin-only; emits an elevated audit
// event because anyone with the secret can forge inbound webhooks.
export const revealInboundSecret = mutation({
  args: { integrationId: v.id('integrations') },
  handler: async (ctx, { integrationId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner', 'admin')
    const row = await ctx.db.get(integrationId)
    if (!row || row.tenantId !== tc.tenantId) {
      throw new ConvexError('INTEGRATION_NOT_FOUND')
    }
    await recordAudit(
      ctx,
      tc,
      'integration.inbound_secret_revealed',
      'integration',
      integrationId,
      { kind: row.kind }
    )
    return { inboundSecret: row.inboundSecret }
  },
})

// Manual sync trigger. The runner does the heavy lifting in an action.
export const runSync = mutation({
  args: { integrationId: v.id('integrations') },
  handler: async (ctx, { integrationId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner', 'admin')
    const row = await ctx.db.get(integrationId)
    if (!row || row.tenantId !== tc.tenantId) {
      throw new ConvexError('INTEGRATION_NOT_FOUND')
    }
    if (row.status === 'disabled') throw new ConvexError('INTEGRATION_DISABLED')

    const runId: Id<'integrationSyncRuns'> = await ctx.db.insert(
      'integrationSyncRuns',
      {
        tenantId: tc.tenantId,
        integrationId,
        trigger: 'manual',
        status: 'running',
        startedAt: Date.now(),
        filesProcessed: 0,
        filesUpserted: 0,
        errorCount: 0,
      }
    )

    await ctx.scheduler.runAfter(0, internal.integrationsRunner.runSync, {
      runId,
    })

    await recordAudit(
      ctx,
      tc,
      'integration.sync_started',
      'integration',
      integrationId,
      {
        runId,
        trigger: 'manual',
      }
    )

    return { runId }
  },
})

// ───────────────────────────────────────────────────────────────────────
// Internal helpers used by the runner / inbound webhook.
// ───────────────────────────────────────────────────────────────────────

export const _loadForRun = internalQuery({
  args: { runId: v.id('integrationSyncRuns') },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId)
    if (!run) return null
    const integration = await ctx.db.get(run.integrationId)
    if (!integration) return null

    let credentialsPlaintext: string | null = null
    if (integration.credentialsToken) {
      const tok = await ctx.db
        .query('npiSecrets')
        .withIndex('by_tenant_token', (q) =>
          q
            .eq('tenantId', integration.tenantId)
            .eq('token', integration.credentialsToken!)
        )
        .unique()
      if (tok && !tok.erased) {
        // The runner re-fetches plaintext via `secrets.reveal` only when it
        // actually needs to call the network — we just signal availability
        // here. (Plaintext leaves Convex only via the elevated `reveal`
        // path, which writes its own audit event.)
        credentialsPlaintext = tok.token
      }
    }

    return {
      tenantId: integration.tenantId,
      integrationId: integration._id,
      kind: integration.kind,
      config: integration.config,
      cursor: integration.cursor ?? null,
      lastSyncAt: integration.lastSyncAt ?? null,
      hasCredentials: credentialsPlaintext !== null,
    }
  },
})

export const _markRunStarted = internalMutation({
  args: { runId: v.id('integrationSyncRuns') },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId)
    if (!run) return
    await ctx.db.patch(runId, { status: 'running', startedAt: Date.now() })
  },
})

export const _markRunFinished = internalMutation({
  args: {
    runId: v.id('integrationSyncRuns'),
    success: v.boolean(),
    filesProcessed: v.number(),
    filesUpserted: v.number(),
    errorCount: v.number(),
    errorSample: v.optional(v.string()),
    nextCursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (
    ctx,
    {
      runId,
      success,
      filesProcessed,
      filesUpserted,
      errorCount,
      errorSample,
      nextCursor,
    }
  ) => {
    const run = await ctx.db.get(runId)
    if (!run) return
    const integration = await ctx.db.get(run.integrationId)

    await ctx.db.patch(runId, {
      status: success ? 'succeeded' : 'failed',
      completedAt: Date.now(),
      filesProcessed,
      filesUpserted,
      errorCount,
      errorSample,
    })

    if (integration) {
      await ctx.db.patch(integration._id, {
        lastSyncAt: Date.now(),
        lastSyncStatus: success ? 'succeeded' : 'failed',
        lastError: success ? undefined : errorSample,
        cursor:
          nextCursor === null ? undefined : (nextCursor ?? integration.cursor),
        filesSyncedTotal: integration.filesSyncedTotal + filesUpserted,
        status: success
          ? integration.status === 'error'
            ? 'active'
            : integration.status
          : integration.status === 'disabled'
            ? 'disabled'
            : 'error',
      })
    }
  },
})

// Idempotent upsert keyed on (tenantId, fileNumber). When we already have a
// row we patch it; otherwise we insert. We deliberately do NOT touch
// `parties` or `documents` here — those are populated by their own flows.
//
// `searchText` is rebuilt from the snapshot so the file-search index stays
// up-to-date as integrations push changes.
export const _upsertFileFromSnapshot = internalMutation({
  args: {
    tenantId: v.id('tenants'),
    integrationKind: integrationKind,
    snapshot: v.any(),
  },
  handler: async (
    ctx,
    {
      tenantId,
      integrationKind: kind,
      snapshot,
    }: {
      tenantId: Id<'tenants'>
      integrationKind:
        | 'softpro_360'
        | 'softpro_standard'
        | 'qualia'
        | 'resware'
        | 'encompass'
        | 'mock'
      snapshot: {
        externalId: string
        fileNumber: string
        externalStatus?: string
        stateCode?: string
        countyFips?: string
        transactionType?: string
        propertyApn?: string
        propertyAddress?: {
          line1: string
          line2?: string
          city: string
          state: string
          zip: string
        }
      }
    }
  ) => {
    if (!snapshot.fileNumber)
      throw new ConvexError('SNAPSHOT_MISSING_FILENUMBER')

    // Need a county. If we have a FIPS code, look it up; otherwise fall back
    // to "uncategorized" by failing loudly so the operator notices.
    let countyId: Id<'counties'> | null = null
    if (snapshot.countyFips) {
      const county = await ctx.db
        .query('counties')
        .withIndex('by_fips', (q) => q.eq('fipsCode', snapshot.countyFips!))
        .unique()
      if (county) countyId = county._id
    }
    if (!countyId) throw new ConvexError('COUNTY_NOT_RESOLVED')

    const existing = await ctx.db
      .query('files')
      .withIndex('by_tenant_filenumber', (q) =>
        q.eq('tenantId', tenantId).eq('fileNumber', snapshot.fileNumber)
      )
      .unique()

    const externalRefs: {
      softproId?: string
      qualiaId?: string
      reswareId?: string
    } = {}
    // Both SoftPro variants share the `softproId` slot — they're the same
    // vendor from the agency's POV, just different transport modes. If we
    // ever need to distinguish (e.g. dual-stack agency mid-migration),
    // widen the schema.
    if (kind === 'softpro_360' || kind === 'softpro_standard') {
      externalRefs.softproId = snapshot.externalId
    } else if (kind === 'qualia') externalRefs.qualiaId = snapshot.externalId
    else if (kind === 'resware') externalRefs.reswareId = snapshot.externalId

    const transactionType = snapshot.transactionType ?? 'purchase'
    const stateCode = snapshot.stateCode ?? 'IN'

    const county = await ctx.db.get(countyId)

    const searchText = [
      snapshot.fileNumber,
      transactionType,
      snapshot.propertyApn,
      snapshot.propertyAddress?.line1,
      snapshot.propertyAddress?.line2,
      snapshot.propertyAddress?.city,
      snapshot.propertyAddress?.state,
      snapshot.propertyAddress?.zip,
      county?.name,
    ]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join(' ')

    if (existing) {
      await ctx.db.patch(existing._id, {
        externalRefs: { ...existing.externalRefs, ...externalRefs },
        propertyApn: snapshot.propertyApn ?? existing.propertyApn,
        propertyAddress: snapshot.propertyAddress ?? existing.propertyAddress,
        transactionType,
        stateCode,
        countyId,
        searchText,
      })
      return { fileId: existing._id, inserted: false }
    }

    const fileId = await ctx.db.insert('files', {
      tenantId,
      fileNumber: snapshot.fileNumber,
      externalRefs,
      stateCode,
      countyId,
      transactionType,
      status: 'opened',
      propertyApn: snapshot.propertyApn,
      propertyAddress: snapshot.propertyAddress,
      searchText,
      openedAt: Date.now(),
    })
    return { fileId, inserted: true }
  },
})

// Returns the row's inboundSecret + minimal context for the webhook
// httpAction to verify. Internal-only — never expose the secret to a
// public function.
export const _loadInboundSecretForVerify = internalQuery({
  args: { integrationId: v.id('integrations') },
  handler: async (ctx, { integrationId }) => {
    const row = await ctx.db.get(integrationId)
    if (!row) return null
    return {
      tenantId: row.tenantId,
      status: row.status,
      inboundSecret: row.inboundSecret,
    }
  },
})

export const _enqueueWebhookSync = internalMutation({
  args: {
    tenantId: v.id('tenants'),
    integrationId: v.id('integrations'),
  },
  handler: async (ctx, { tenantId, integrationId }) => {
    const runId: Id<'integrationSyncRuns'> = await ctx.db.insert(
      'integrationSyncRuns',
      {
        tenantId,
        integrationId,
        trigger: 'webhook',
        status: 'running',
        startedAt: Date.now(),
        filesProcessed: 0,
        filesUpserted: 0,
        errorCount: 0,
      }
    )
    await ctx.scheduler.runAfter(0, internal.integrationsRunner.runSync, {
      runId,
    })
    return { runId }
  },
})

// ───────────────────────────────────────────────────────────────────────
// Agent push-mode endpoints (Phase 1 server contract for the SoftPro
// Standard customer-side agent). The HTTP handlers in convex/http.ts
// verify HMAC on the raw body before calling these.
// ───────────────────────────────────────────────────────────────────────

const fileSnapshotV = v.object({
  externalId: v.string(),
  fileNumber: v.string(),
  externalStatus: v.optional(v.string()),
  stateCode: v.optional(v.string()),
  countyFips: v.optional(v.string()),
  transactionType: v.optional(v.string()),
  propertyApn: v.optional(v.string()),
  propertyAddress: v.optional(
    v.object({
      line1: v.string(),
      line2: v.optional(v.string()),
      city: v.string(),
      state: v.string(),
      zip: v.string(),
    })
  ),
  parties: v.array(
    v.object({
      role: v.string(),
      legalName: v.string(),
      partyType: v.union(
        v.literal('person'),
        v.literal('entity'),
        v.literal('trust'),
        v.literal('estate')
      ),
      capacity: v.optional(v.string()),
    })
  ),
  updatedAt: v.number(),
})

// Per-request snapshot ceiling. Agents that have more in flight should
// page across multiple requests — keeps each upsert batch inside Convex's
// per-mutation limits and bounds blast-radius if an agent goes haywire.
const MAX_SNAPSHOTS_PER_PUSH = 100

export const _agentPushSnapshots = internalMutation({
  args: {
    integrationId: v.id('integrations'),
    snapshots: v.array(fileSnapshotV),
    watermark: v.optional(v.string()),
  },
  handler: async (ctx, { integrationId, snapshots, watermark }) => {
    const row = await ctx.db.get(integrationId)
    if (!row) throw new ConvexError('INTEGRATION_NOT_FOUND')
    if (!PUSH_MODE_KINDS.has(row.kind)) {
      throw new ConvexError('INTEGRATION_NOT_PUSH_MODE')
    }
    if (row.status === 'disabled') throw new ConvexError('INTEGRATION_DISABLED')
    if (snapshots.length > MAX_SNAPSHOTS_PER_PUSH) {
      throw new ConvexError('PUSH_BATCH_TOO_LARGE')
    }

    const runId: Id<'integrationSyncRuns'> = await ctx.db.insert(
      'integrationSyncRuns',
      {
        tenantId: row.tenantId,
        integrationId,
        trigger: 'webhook',
        status: 'running',
        startedAt: Date.now(),
        filesProcessed: 0,
        filesUpserted: 0,
        errorCount: 0,
      }
    )

    let inserted = 0
    let errorCount = 0
    let errorSample: string | undefined
    for (const snap of snapshots) {
      try {
        const result: { fileId: Id<'files'>; inserted: boolean } =
          await ctx.runMutation(internal.integrations._upsertFileFromSnapshot, {
            tenantId: row.tenantId,
            integrationKind: row.kind,
            snapshot: snap,
          })
        if (result.inserted) inserted++
      } catch (err) {
        errorCount++
        if (!errorSample) {
          errorSample = `upsert(${snap.externalId}): ${
            err instanceof Error ? err.message : String(err)
          }`
        }
      }
    }

    await ctx.db.patch(runId, {
      status: errorCount === 0 ? 'succeeded' : 'failed',
      completedAt: Date.now(),
      filesProcessed: snapshots.length,
      filesUpserted: inserted,
      errorCount,
      errorSample,
    })
    await ctx.db.patch(integrationId, {
      lastSyncAt: Date.now(),
      lastSyncStatus: errorCount === 0 ? 'succeeded' : 'failed',
      lastError: errorCount === 0 ? undefined : errorSample,
      filesSyncedTotal: row.filesSyncedTotal + inserted,
      agentWatermark: watermark ?? row.agentWatermark,
      status:
        errorCount === 0
          ? row.status === 'error'
            ? 'active'
            : row.status
          : 'error',
    })

    return {
      runId,
      filesProcessed: snapshots.length,
      filesUpserted: inserted,
      errorCount,
    }
  },
})

export const _agentRecordHeartbeat = internalMutation({
  args: {
    integrationId: v.id('integrations'),
    agentVersion: v.string(),
    hostname: v.string(),
  },
  handler: async (ctx, { integrationId, agentVersion, hostname }) => {
    const row = await ctx.db.get(integrationId)
    if (!row) throw new ConvexError('INTEGRATION_NOT_FOUND')
    if (!PUSH_MODE_KINDS.has(row.kind)) {
      throw new ConvexError('INTEGRATION_NOT_PUSH_MODE')
    }
    await ctx.db.patch(integrationId, {
      agentLastHeartbeatAt: Date.now(),
      agentVersion,
      agentHostname: hostname,
    })
    return { ok: true }
  },
})

// Surfaced to admins so they can hand the install token to the agent.
// The integrationId + inboundSecret pair is everything an agent needs.
export const agentInstallInfo = mutation({
  args: { integrationId: v.id('integrations') },
  handler: async (ctx, { integrationId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner', 'admin')
    const row = await ctx.db.get(integrationId)
    if (!row || row.tenantId !== tc.tenantId) {
      throw new ConvexError('INTEGRATION_NOT_FOUND')
    }
    if (!PUSH_MODE_KINDS.has(row.kind)) {
      throw new ConvexError('INTEGRATION_NOT_PUSH_MODE')
    }
    await recordAudit(
      ctx,
      tc,
      'integration.agent_install_revealed',
      'integration',
      integrationId,
      { kind: row.kind }
    )
    return {
      integrationId: row._id,
      inboundSecret: row.inboundSecret,
      // The agent needs the deployment URL too, but it's pulled from
      // env on the client side (the admin pastes the install token, the
      // installer reads CONVEX_SITE_URL from its bundled config).
    }
  },
})
