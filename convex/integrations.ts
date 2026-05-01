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
        parties?: Array<{
          role: string
          legalName: string
          partyType: 'person' | 'entity' | 'trust' | 'estate'
          capacity?: string
        }>
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

    let fileId: Id<'files'>
    let inserted: boolean
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
      fileId = existing._id
      inserted = false
    } else {
      fileId = await ctx.db.insert('files', {
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
      inserted = true
    }

    // Reconcile parties from the snapshot. Additive only — we never delete
    // a party or fileParties link that exists locally but is missing from
    // the snapshot, since the agency may have added parties manually after
    // the source-system intake. Re-using existing `parties` rows by
    // (tenant, legalName, partyType) keeps the global party registry from
    // accumulating duplicates across resyncs.
    if (Array.isArray(snapshot.parties) && snapshot.parties.length > 0) {
      const existingLinks = await ctx.db
        .query('fileParties')
        .withIndex('by_tenant_file', (q) =>
          q.eq('tenantId', tenantId).eq('fileId', fileId)
        )
        .collect()
      const seen = new Set(
        existingLinks.map((fp) => `${fp.partyId}|${fp.role}`)
      )

      for (const sp of snapshot.parties) {
        const legalName = sp.legalName?.trim()
        if (!legalName || !sp.role || !sp.partyType) continue

        const matchingByName = await ctx.db
          .query('parties')
          .withIndex('by_tenant_legalname', (q) =>
            q.eq('tenantId', tenantId).eq('legalName', legalName)
          )
          .collect()
        const reuseable = matchingByName.find(
          (p) => p.partyType === sp.partyType
        )

        const partyId =
          reuseable?._id ??
          (await ctx.db.insert('parties', {
            tenantId,
            partyType: sp.partyType,
            legalName,
          }))

        const linkKey = `${partyId}|${sp.role}`
        if (seen.has(linkKey)) continue

        await ctx.db.insert('fileParties', {
          tenantId,
          fileId,
          partyId,
          role: sp.role,
          capacity: sp.capacity,
        })
        seen.add(linkKey)
      }
    }

    return { fileId, inserted }
  },
})

// Mock-only enrichment: insert document rows + succeeded extractions for a
// freshly-synced mock file, then run reconciliation. The runner uploads
// placeholder blobs to storage in the action context (we can't from here)
// and passes the storageIds in. Idempotent — bails if the file already has
// any documents, so re-syncs don't create duplicates or wipe manually-added
// documents.
export const _seedMockDocuments = internalMutation({
  args: {
    tenantId: v.id('tenants'),
    fileId: v.id('files'),
    docs: v.array(
      v.object({
        storageId: v.id('_storage'),
        docType: v.string(),
        title: v.string(),
        payload: v.any(),
      })
    ),
  },
  handler: async (ctx, { tenantId, fileId, docs }) => {
    if (docs.length === 0) return { inserted: 0 }

    const file = await ctx.db.get(fileId)
    if (!file || file.tenantId !== tenantId) return { inserted: 0 }

    const existingDocs = await ctx.db
      .query('documents')
      .withIndex('by_tenant_file', (q) =>
        q.eq('tenantId', tenantId).eq('fileId', fileId)
      )
      .take(1)
    if (existingDocs.length > 0) return { inserted: 0 }

    // Attribution: documents.uploadedByMemberId is required. Pick the
    // tenant's owner (or any active member) so the row is well-formed.
    const members = await ctx.db
      .query('tenantMembers')
      .withIndex('by_tenant_email', (q) => q.eq('tenantId', tenantId))
      .collect()
    const member =
      members.find((m) => m.role === 'owner' && m.status === 'active') ??
      members.find((m) => m.status === 'active')
    if (!member) return { inserted: 0 }

    const now = Date.now()
    let inserted = 0
    for (const d of docs) {
      const meta = await ctx.db.system.get(d.storageId)
      const documentId = await ctx.db.insert('documents', {
        tenantId,
        fileId,
        docType: d.docType,
        title: d.title,
        storageId: d.storageId,
        contentType: meta?.contentType,
        sizeBytes: meta?.size,
        checksum: meta?.sha256,
        uploadedByMemberId: member._id,
        uploadedAt: now,
      })
      await ctx.db.insert('documentExtractions', {
        tenantId,
        fileId,
        documentId,
        status: 'succeeded',
        payload: d.payload,
        modelId: 'mock-fixture',
        source: 'mock',
        startedAt: now,
        completedAt: now,
      })
      inserted++
    }

    // Drive reconciliation off the seeded extractions so the Order
    // Management UI shows real finding severities.
    await ctx.runMutation(internal.reconciliation.runForFileAuto, {
      tenantId,
      fileId,
    })

    return { inserted }
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

// ─── Agent install tokens ────────────────────────────────────────────────
//
// Short-lived, single-use credentials. Admin clicks "Generate install
// command" in the web UI, gets a token they can hand to the agency's IT
// admin (via the same channels they use for any other secret — DM, ticket,
// printout). The agent redeems it once, gets the integration id + inbound
// secret, and never sees the plaintext token again.
//
// Properties:
//   • TTL is 15 minutes — short enough that a forgotten command in shell
//     history is low-value to an attacker.
//   • Single-use — `consumedAt` is set at first redemption.
//   • 256 bits of entropy — `crypto.getRandomValues(32)` hex-encoded.
//   • Plaintext never stored — only `tokenHash` (hex SHA-256) lives on disk.

const INSTALL_TOKEN_TTL_MS = 15 * 60_000

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input)
  )
  return Array.from(new Uint8Array(buf), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
}

function newAgentToken(): string {
  // 32 bytes → 64 hex chars. Same shape as inboundSecret so the agent can
  // pre-validate (length + hex) before sending it on the wire.
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

export const generateAgentInstallToken = mutation({
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

    const token = newAgentToken()
    const tokenHash = await sha256Hex(token)
    const now = Date.now()
    const expiresAt = now + INSTALL_TOKEN_TTL_MS

    const tokenId = await ctx.db.insert('agentInstallTokens', {
      tenantId: tc.tenantId,
      integrationId,
      tokenHash,
      prefix: token.slice(0, 8),
      expiresAt,
      createdByMemberId: tc.memberId,
      createdAt: now,
    })

    await recordAudit(
      ctx,
      tc,
      'integration.agent_install_token_generated',
      'integration',
      integrationId,
      { tokenId, expiresAt, prefix: token.slice(0, 8) }
    )

    return {
      // PLAINTEXT — shown once. The admin UI surfaces this exactly once
      // and then forgets it; refreshing the page drops it.
      token,
      tokenId,
      expiresAt,
      prefix: token.slice(0, 8),
    }
  },
})

export const revokeAgentInstallToken = mutation({
  args: { tokenId: v.id('agentInstallTokens') },
  handler: async (ctx, { tokenId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner', 'admin')
    const row = await ctx.db.get(tokenId)
    if (!row || row.tenantId !== tc.tenantId) {
      throw new ConvexError('INSTALL_TOKEN_NOT_FOUND')
    }
    if (row.consumedAt) {
      // Already consumed — revocation is a no-op, but audit it so the
      // admin sees their click was registered.
      await recordAudit(
        ctx,
        tc,
        'integration.agent_install_token_revoke_noop',
        'integration',
        row.integrationId,
        { tokenId }
      )
      return { ok: true, alreadyConsumed: true }
    }
    // Expire the token by hard-deleting; we keep the audit trail in
    // auditEvents, but a deleted row can't be redeemed.
    await ctx.db.delete(tokenId)
    await recordAudit(
      ctx,
      tc,
      'integration.agent_install_token_revoked',
      'integration',
      row.integrationId,
      { tokenId, prefix: row.prefix }
    )
    return { ok: true, alreadyConsumed: false }
  },
})

export const listAgentInstallTokens = query({
  args: { integrationId: v.id('integrations') },
  handler: async (ctx, { integrationId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner', 'admin')
    const rows = await ctx.db
      .query('agentInstallTokens')
      .withIndex('by_tenant_integration', (q) =>
        q.eq('tenantId', tc.tenantId).eq('integrationId', integrationId)
      )
      .order('desc')
      .take(20)
    // Never leak `tokenHash` to the client; only metadata.
    return rows.map((r) => ({
      _id: r._id,
      prefix: r.prefix,
      expiresAt: r.expiresAt,
      consumedAt: r.consumedAt ?? null,
      createdAt: r.createdAt,
      // Convenience flag — easier than re-deriving on the client every render.
      status:
        r.consumedAt != null
          ? ('consumed' as const)
          : r.expiresAt < Date.now()
            ? ('expired' as const)
            : ('active' as const),
    }))
  },
})

// Internal: validate a plaintext token WITHOUT consuming it. Used by the
// `/agent/install.{ps1,sh}` bootstrap endpoint, which generates a script
// containing the token; the actual redemption happens later when the
// downloaded agent calls `/integrations/agent/redeem`. Returning ok-status
// here lets the bootstrap fail fast if the admin pasted a stale URL.
export const _validateAgentInstallToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    if (!/^[a-f0-9]{64}$/.test(token)) {
      throw new ConvexError('INSTALL_TOKEN_MALFORMED')
    }
    const tokenHash = await sha256Hex(token)
    const row = await ctx.db
      .query('agentInstallTokens')
      .withIndex('by_token_hash', (q) => q.eq('tokenHash', tokenHash))
      .unique()
    if (!row) throw new ConvexError('INSTALL_TOKEN_NOT_FOUND')
    if (row.consumedAt != null) {
      throw new ConvexError('INSTALL_TOKEN_ALREADY_USED')
    }
    if (row.expiresAt < Date.now()) {
      throw new ConvexError('INSTALL_TOKEN_EXPIRED')
    }
    return { ok: true as const, expiresAt: row.expiresAt }
  },
})

// Internal: redeem a plaintext token. Called by the public HTTP endpoint
// in convex/http.ts. Lives here so the table access stays colocated with
// the rest of the integrations module.
export const _redeemAgentInstallToken = internalMutation({
  args: { token: v.string(), fromIp: v.optional(v.string()) },
  handler: async (
    ctx,
    { token, fromIp }
  ): Promise<{
    integrationId: Id<'integrations'>
    inboundSecret: string
  }> => {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      throw new ConvexError('INSTALL_TOKEN_MALFORMED')
    }
    const tokenHash = await sha256Hex(token)
    const tokenRow = await ctx.db
      .query('agentInstallTokens')
      .withIndex('by_token_hash', (q) => q.eq('tokenHash', tokenHash))
      .unique()
    if (!tokenRow) throw new ConvexError('INSTALL_TOKEN_NOT_FOUND')
    if (tokenRow.consumedAt != null) {
      throw new ConvexError('INSTALL_TOKEN_ALREADY_USED')
    }
    if (tokenRow.expiresAt < Date.now()) {
      throw new ConvexError('INSTALL_TOKEN_EXPIRED')
    }

    const integration = await ctx.db.get(tokenRow.integrationId)
    if (!integration || integration.tenantId !== tokenRow.tenantId) {
      throw new ConvexError('INTEGRATION_NOT_FOUND')
    }
    if (!PUSH_MODE_KINDS.has(integration.kind)) {
      throw new ConvexError('INTEGRATION_NOT_PUSH_MODE')
    }
    if (integration.status === 'disabled') {
      throw new ConvexError('INTEGRATION_DISABLED')
    }

    // Mark consumed atomically, BEFORE returning the secret. If anything
    // throws after this point, the token still can't be reused.
    await ctx.db.patch(tokenRow._id, {
      consumedAt: Date.now(),
      consumedFromIp: fromIp,
    })
    await ctx.db.insert('auditEvents', {
      tenantId: tokenRow.tenantId,
      actorType: 'system',
      action: 'integration.agent_install_token_redeemed',
      resourceType: 'integration',
      resourceId: tokenRow.integrationId,
      metadata: {
        tokenId: tokenRow._id,
        prefix: tokenRow.prefix,
        fromIp: fromIp ?? null,
      },
      occurredAt: Date.now(),
    })

    return {
      integrationId: integration._id,
      inboundSecret: integration.inboundSecret,
    }
  },
})
