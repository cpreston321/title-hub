import { ConvexError, v } from 'convex/values'
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { internal } from './_generated/api'
import { recordAudit } from './lib/audit'
import { requireRole, requireTenant } from './lib/tenant'
import { autoPromoteFileStatus, scheduleExtractionFor } from './files'
import { fanOutNotification } from './notifications'
import type { Doc, Id } from './_generated/dataModel'

// Title search orders — async vendor lookups (DataTrace TPS Full Title) that
// arrive as a PDF. Lifecycle:
//
//   place → placeOrderAction → vendor accepts (vendorOrderId stored)
//                            → status `in_progress`
//   webhook → receiveDeliveryAction → PDF stored + documents row created
//                                   → status `delivered` + extraction queued
//
// Two providers behind the same surface:
//   - 'datatrace' (live): used when DATATRACE_API_KEY is set. The order
//     placement POSTs to the vendor; the vendor calls our
//     /integrations/datatrace/delivery webhook when the report is ready.
//   - 'mock' (dev): no key needed. Placement schedules a delayed (~30s)
//     mock delivery that lands a small placeholder PDF the same way a real
//     delivery would, so the rest of the pipeline can be exercised in dev.

const orderRoles = ['owner', 'admin', 'processor', 'closer'] as const

const MOCK_DELIVERY_DELAY_MS = 30_000
const MAX_VENDOR_MESSAGES = 20

function newCallbackToken(): string {
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

function appendMessage(
  prior: Doc<'titleSearchOrders'>['vendorMessages'],
  level: 'info' | 'warn' | 'error',
  message: string | undefined | null
): Doc<'titleSearchOrders'>['vendorMessages'] {
  if (!message || message.length === 0) return prior
  const next = [
    ...prior,
    { at: Date.now(), level, message: message.slice(0, 500) },
  ]
  return next.length > MAX_VENDOR_MESSAGES
    ? next.slice(next.length - MAX_VENDOR_MESSAGES)
    : next
}

async function hexSha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const buf = await crypto.subtle.digest('SHA-256', copy.buffer)
  return Array.from(new Uint8Array(buf), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
}

// Synthesizes a `title_search` extraction payload for a mock order so the
// reconciliation engine has structured data to work with. Shape mirrors
// extractionsRunner.ExtractionPayload for documentKind: 'title_search'.
// Real DataTrace TPS reports populate richer party / exception data; the
// mock keeps just enough signal to exercise the file UI's doc-ready state.
function mockTitleSearchPayload(addr: {
  line1: string
  city: string
  state: string
  zip: string
}): Record<string, unknown> {
  return {
    documentKind: 'title_search',
    parties: [],
    property: {
      address: `${addr.line1}, ${addr.city}, ${addr.state} ${addr.zip}`,
      state: addr.state,
      zip: addr.zip,
    },
    financial: null,
    dates: null,
    titleCompany: null,
    contingencies: [],
    amendments: [],
    notes: [
      'Mock title search — placeholder fixture for development.',
      'No exceptions found.',
      'No open liens of record.',
    ],
  }
}

// ── Public surface ─────────────────────────────────────────────────────

export type OrderForFile = {
  _id: Id<'titleSearchOrders'>
  vendor: 'datatrace' | 'mock'
  product: 'tps_full_title'
  status: Doc<'titleSearchOrders'>['status']
  requestedAt: number
  inProgressAt: number | null
  deliveredAt: number | null
  failedAt: number | null
  cancelledAt: number | null
  failureMessage: string | null
  vendorOrderId: string | null
  vendorReference: string | null
  queryAddress: Doc<'titleSearchOrders'>['queryAddress']
  deliveryDocumentId: Id<'documents'> | null
  vendorMessages: Doc<'titleSearchOrders'>['vendorMessages']
}

function publicOrder(row: Doc<'titleSearchOrders'>): OrderForFile {
  return {
    _id: row._id,
    vendor: row.vendor,
    product: row.product,
    status: row.status,
    requestedAt: row.requestedAt,
    inProgressAt: row.inProgressAt ?? null,
    deliveredAt: row.deliveredAt ?? null,
    failedAt: row.failedAt ?? null,
    cancelledAt: row.cancelledAt ?? null,
    failureMessage: row.failureMessage ?? null,
    vendorOrderId: row.vendorOrderId ?? null,
    vendorReference: row.vendorReference ?? null,
    queryAddress: row.queryAddress,
    deliveryDocumentId: row.deliveryDocumentId ?? null,
    vendorMessages: row.vendorMessages,
  }
}

export const listForFile = query({
  args: { fileId: v.id('files') },
  handler: async (ctx, { fileId }): Promise<ReadonlyArray<OrderForFile>> => {
    const tc = await requireTenant(ctx)
    const file = await ctx.db.get(fileId)
    if (!file || file.tenantId !== tc.tenantId) return []
    const rows = await ctx.db
      .query('titleSearchOrders')
      .withIndex('by_tenant_file', (q) =>
        q.eq('tenantId', tc.tenantId).eq('fileId', fileId)
      )
      .order('desc')
      .take(20)
    return rows.map(publicOrder)
  },
})

export const place = mutation({
  args: { fileId: v.id('files') },
  handler: async (
    ctx,
    { fileId }
  ): Promise<{
    orderId: Id<'titleSearchOrders'>
    vendor: 'datatrace' | 'mock'
  }> => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...orderRoles)
    const file = await ctx.db.get(fileId)
    if (!file || file.tenantId !== tc.tenantId) {
      throw new ConvexError('FILE_NOT_FOUND')
    }
    if (!file.propertyAddress) {
      throw new ConvexError('FILE_HAS_NO_ADDRESS')
    }

    // One open order at a time per file. Re-ordering before the prior
    // order resolves is almost always operator error (extra spend), so
    // we surface it as an error rather than silently dropping the request.
    const recent = await ctx.db
      .query('titleSearchOrders')
      .withIndex('by_tenant_file', (q) =>
        q.eq('tenantId', tc.tenantId).eq('fileId', fileId)
      )
      .order('desc')
      .take(5)
    const inFlight = recent.find(
      (r) => r.status === 'requested' || r.status === 'in_progress'
    )
    if (inFlight) throw new ConvexError('TITLE_SEARCH_ALREADY_IN_FLIGHT')

    const vendor: 'datatrace' | 'mock' = process.env.DATATRACE_API_KEY
      ? 'datatrace'
      : 'mock'

    const orderId = await ctx.db.insert('titleSearchOrders', {
      tenantId: tc.tenantId,
      fileId,
      vendor,
      product: 'tps_full_title',
      status: 'requested',
      requestedByMemberId: tc.memberId,
      requestedAt: Date.now(),
      queryAddress: file.propertyAddress,
      vendorReference: file.fileNumber,
      callbackToken: newCallbackToken(),
      vendorMessages: [],
    })

    await recordAudit(ctx, tc, 'title_search_order.placed', 'file', fileId, {
      orderId,
      vendor,
      product: 'tps_full_title',
    })

    await ctx.scheduler.runAfter(
      0,
      internal.titleSearchOrders.placeOrderAction,
      { orderId }
    )

    return { orderId, vendor }
  },
})

export const cancel = mutation({
  args: {
    orderId: v.id('titleSearchOrders'),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { orderId, reason }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...orderRoles)
    const order = await ctx.db.get(orderId)
    if (!order || order.tenantId !== tc.tenantId) {
      throw new ConvexError('ORDER_NOT_FOUND')
    }
    if (order.status !== 'requested' && order.status !== 'in_progress') {
      throw new ConvexError('ORDER_NOT_CANCELABLE')
    }
    await ctx.db.patch(orderId, {
      status: 'cancelled',
      cancelledAt: Date.now(),
      cancelledByMemberId: tc.memberId,
    })
    await recordAudit(
      ctx,
      tc,
      'title_search_order.cancelled',
      'file',
      order.fileId,
      { orderId, reason: reason ?? null }
    )
    return { ok: true }
  },
})

// ── Internal queries / mutations ───────────────────────────────────────

export const _loadForPlacement = internalQuery({
  args: { orderId: v.id('titleSearchOrders') },
  handler: async (
    ctx,
    { orderId }
  ): Promise<Doc<'titleSearchOrders'> | null> => {
    return await ctx.db.get(orderId)
  },
})

// Loaded by the HTTP webhook to verify the per-order callback signature
// without exposing the order to the public API.
export const _loadForCallback = internalQuery({
  args: { orderId: v.id('titleSearchOrders') },
  handler: async (
    ctx,
    { orderId }
  ): Promise<{
    callbackToken: string
    status: Doc<'titleSearchOrders'>['status']
    tenantId: Id<'tenants'>
  } | null> => {
    const o = await ctx.db.get(orderId)
    if (!o) return null
    return {
      callbackToken: o.callbackToken,
      status: o.status,
      tenantId: o.tenantId,
    }
  },
})

export const _markInProgress = internalMutation({
  args: {
    orderId: v.id('titleSearchOrders'),
    vendorOrderId: v.optional(v.string()),
    message: v.optional(v.string()),
  },
  handler: async (ctx, { orderId, vendorOrderId, message }) => {
    const order = await ctx.db.get(orderId)
    if (!order) return
    if (order.status === 'cancelled' || order.status === 'delivered') return
    await ctx.db.patch(orderId, {
      status: 'in_progress',
      inProgressAt: order.inProgressAt ?? Date.now(),
      vendorOrderId: vendorOrderId ?? order.vendorOrderId,
      vendorMessages: appendMessage(order.vendorMessages, 'info', message),
    })
    await ctx.db.insert('auditEvents', {
      tenantId: order.tenantId,
      actorType: 'system',
      action: 'title_search_order.in_progress',
      resourceType: 'file',
      resourceId: order.fileId,
      metadata: { orderId, vendorOrderId: vendorOrderId ?? null },
      occurredAt: Date.now(),
    })
  },
})

export const _markFailed = internalMutation({
  args: {
    orderId: v.id('titleSearchOrders'),
    failureMessage: v.string(),
  },
  handler: async (ctx, { orderId, failureMessage }) => {
    const order = await ctx.db.get(orderId)
    if (!order) return
    if (order.status === 'delivered' || order.status === 'cancelled') return
    await ctx.db.patch(orderId, {
      status: 'failed',
      failedAt: Date.now(),
      failureMessage,
      vendorMessages: appendMessage(
        order.vendorMessages,
        'error',
        failureMessage
      ),
    })
    await ctx.db.insert('auditEvents', {
      tenantId: order.tenantId,
      actorType: 'system',
      action: 'title_search_order.failed',
      resourceType: 'file',
      resourceId: order.fileId,
      metadata: { orderId, failureMessage },
      occurredAt: Date.now(),
    })

    // Surface the failure in the bell — closers paid for this and need to
    // know. Severity 'warn' keeps it distinct from blocking findings.
    const file = await ctx.db.get(order.fileId)
    await fanOutNotification(ctx, order.tenantId, {
      kind: 'title_search.failed',
      severity: 'warn',
      title: 'Title search failed',
      body: file
        ? `On file ${file.fileNumber} — ${failureMessage}`
        : failureMessage,
      fileId: order.fileId,
      actorType: 'system',
    })
  },
})

export const _appendVendorMessage = internalMutation({
  args: {
    orderId: v.id('titleSearchOrders'),
    level: v.union(
      v.literal('info'),
      v.literal('warn'),
      v.literal('error')
    ),
    message: v.string(),
  },
  handler: async (ctx, { orderId, level, message }) => {
    const order = await ctx.db.get(orderId)
    if (!order) return
    await ctx.db.patch(orderId, {
      vendorMessages: appendMessage(order.vendorMessages, level, message),
    })
  },
})

// Inserts the documents row for the delivered PDF, schedules the same
// extraction the manual upload path uses, and flips the order to
// `delivered`. Idempotent: a duplicate delivery callback discards the new
// blob and returns the existing document id.
export const _attachDeliveredPdf = internalMutation({
  args: {
    orderId: v.id('titleSearchOrders'),
    storageId: v.id('_storage'),
    sizeBytes: v.number(),
    contentType: v.optional(v.string()),
    sha256: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { orderId, storageId, sizeBytes, contentType, sha256 }
  ): Promise<{
    documentId: Id<'documents'>
    deduped: boolean
  }> => {
    const order = await ctx.db.get(orderId)
    if (!order) throw new ConvexError('ORDER_NOT_FOUND')

    if (order.status === 'delivered') {
      try {
        await ctx.storage.delete(storageId)
      } catch {
        /* best-effort */
      }
      if (!order.deliveryDocumentId) {
        throw new ConvexError('DELIVERED_BUT_NO_DOCUMENT')
      }
      return { documentId: order.deliveryDocumentId, deduped: true }
    }
    if (order.status === 'cancelled' || order.status === 'failed') {
      try {
        await ctx.storage.delete(storageId)
      } catch {
        /* best-effort */
      }
      throw new ConvexError('ORDER_NOT_OPEN')
    }

    // Pick an upload attribution: original requester if still active,
    // otherwise any active owner/admin (mirrors the integration upload path).
    let uploaderId: Id<'tenantMembers'> | null = null
    const requester = await ctx.db.get(order.requestedByMemberId)
    if (requester && requester.status === 'active') {
      uploaderId = requester._id
    }
    if (!uploaderId) {
      const members = await ctx.db
        .query('tenantMembers')
        .withIndex('by_tenant_email', (q) => q.eq('tenantId', order.tenantId))
        .collect()
      const m =
        members.find((mm) => mm.role === 'owner' && mm.status === 'active') ??
        members.find((mm) => mm.status === 'active')
      if (!m) {
        try {
          await ctx.storage.delete(storageId)
        } catch {
          /* best-effort */
        }
        throw new ConvexError('NO_ACTIVE_MEMBER')
      }
      uploaderId = m._id
    }

    const addr = order.queryAddress
    const titleSuffix = `${addr.line1}, ${addr.city}, ${addr.state}`
    const documentId = await ctx.db.insert('documents', {
      tenantId: order.tenantId,
      fileId: order.fileId,
      docType: 'title_search',
      title: `${order.vendor === 'mock' ? 'Mock ' : ''}DataTrace TPS Full Title — ${titleSuffix}`,
      storageId,
      contentType: contentType ?? 'application/pdf',
      sizeBytes,
      checksum: sha256,
      uploadedByMemberId: uploaderId,
      uploadedAt: Date.now(),
    })

    // Mock vendors skip the Claude extraction (the placeholder bytes are
    // not a parseable PDF and there's no API key in dev anyway). Instead
    // we synthesize a succeeded extraction with a plausible title_search
    // payload so the rest of the pipeline — reconciliation, the file UI's
    // doc-readiness signals — can be exercised end-to-end. Live deliveries
    // go through the real extractor.
    let extractionId: Id<'documentExtractions'>
    if (order.vendor === 'mock') {
      const now = Date.now()
      extractionId = await ctx.db.insert('documentExtractions', {
        tenantId: order.tenantId,
        fileId: order.fileId,
        documentId,
        status: 'succeeded',
        payload: mockTitleSearchPayload(addr),
        modelId: 'mock-fixture',
        source: 'mock',
        startedAt: now,
        completedAt: now,
      })
      await ctx.runMutation(internal.reconciliation.runForFileAuto, {
        tenantId: order.tenantId,
        fileId: order.fileId,
      })
    } else {
      extractionId = await scheduleExtractionFor(ctx, order.tenantId, {
        documentId,
        fileId: order.fileId,
        storageId,
        docType: 'title_search',
      })
    }

    await ctx.db.patch(orderId, {
      status: 'delivered',
      deliveredAt: Date.now(),
      pdfStorageId: storageId,
      deliveryDocumentId: documentId,
      vendorMessages: appendMessage(
        order.vendorMessages,
        'info',
        'PDF delivered.'
      ),
    })

    await ctx.db.insert('auditEvents', {
      tenantId: order.tenantId,
      actorType: 'system',
      action: 'title_search_order.delivered',
      resourceType: 'file',
      resourceId: order.fileId,
      metadata: {
        orderId,
        documentId,
        extractionId,
        vendor: order.vendor,
        sizeBytes,
      },
      occurredAt: Date.now(),
    })

    // Lifecycle nudge: opened → in_exam on first delivery. The live path
    // would also advance once Claude finishes extracting (via
    // extractions.markSucceeded), but we want the file in the right
    // bucket the moment the report is in operator hands. autoPromoteFileStatus
    // is a no-op when the file isn't in `opened` so the second call is safe.
    await autoPromoteFileStatus(
      ctx,
      order.fileId,
      ['opened'],
      'in_exam',
      'title_search_delivered'
    )

    // Notify the team. This is a distinct event from `extraction.succeeded`
    // (different timing — delivery happens minutes before extraction in the
    // live path — and different operator meaning: "the report is here" vs
    // "we've read it"). The bell groups by `kind:fileId` so multiple title
    // searches on the same file collapse, but extraction notifications stay
    // their own row.
    const file = await ctx.db.get(order.fileId)
    await fanOutNotification(ctx, order.tenantId, {
      kind: 'title_search.delivered',
      severity: 'ok',
      title: order.vendor === 'mock'
        ? 'Mock title search delivered'
        : 'Title search delivered',
      body: file
        ? `On file ${file.fileNumber} — extraction is running`
        : undefined,
      fileId: order.fileId,
      actorType: 'system',
    })

    return { documentId, deduped: false }
  },
})

// ── Retention ──────────────────────────────────────────────────────────
// Terminal-state orders (delivered / failed / cancelled) past the retention
// horizon get hard-deleted by a daily cron. The corresponding `documents`
// rows and `auditEvents` are NOT touched — those are the system of record.
// What we drop is operational state (vendor message log, callback token,
// raw request/response handles) that's stale once the order's resolved.

const RETENTION_DAYS = 365
const PURGE_BATCH_SIZE = 100
const TERMINAL_STATUSES = ['delivered', 'failed', 'cancelled'] as const

export const purgeOldOrders = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ deleted: number; rescheduled: boolean }> => {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    let deleted = 0
    for (const status of TERMINAL_STATUSES) {
      // Per-status batch keeps each query index-resident. Stop at
      // PURGE_BATCH_SIZE total to stay within transaction limits.
      const remaining = PURGE_BATCH_SIZE - deleted
      if (remaining <= 0) break
      const rows = await ctx.db
        .query('titleSearchOrders')
        .withIndex('by_status_requested', (q) =>
          q.eq('status', status).lt('requestedAt', cutoff)
        )
        .take(remaining)
      for (const r of rows) {
        await ctx.db.delete(r._id)
        deleted++
      }
    }
    // If we filled the batch there's likely more — chain another run on
    // the same transaction's success so a backlog drains without waiting
    // a full cron interval.
    const rescheduled = deleted >= PURGE_BATCH_SIZE
    if (rescheduled) {
      await ctx.scheduler.runAfter(
        0,
        internal.titleSearchOrders.purgeOldOrders,
        {}
      )
    }
    return { deleted, rescheduled }
  },
})

// ── Vendor placement / delivery actions ────────────────────────────────

// Real DataTrace endpoints depend on their published API spec; the URL,
// auth header, and order-create body shape below reflect a typical
// "create an order, give us a webhook URL" flow. Wire credentials with:
//   npx convex env set DATATRACE_API_KEY <key>
//   npx convex env set DATATRACE_CALLBACK_BASE_URL <https://...convex.site>
// Without DATATRACE_API_KEY the order resolves through the mock path.
const DATATRACE_BASE = 'https://api.datatracecorp.com/v1'

export const placeOrderAction = internalAction({
  args: { orderId: v.id('titleSearchOrders') },
  handler: async (ctx, { orderId }): Promise<null> => {
    const order: Doc<'titleSearchOrders'> | null = await ctx.runQuery(
      internal.titleSearchOrders._loadForPlacement,
      { orderId }
    )
    if (!order || order.status !== 'requested') return null

    if (order.vendor === 'mock') {
      await ctx.runMutation(internal.titleSearchOrders._markInProgress, {
        orderId,
        vendorOrderId: `MOCK-${order._id}`,
        message: 'Mock order acknowledged.',
      })
      // Simulate vendor processing time. Mirrors what the live webhook does.
      await ctx.scheduler.runAfter(
        MOCK_DELIVERY_DELAY_MS,
        internal.titleSearchOrders.deliverMockOrder,
        { orderId }
      )
      return null
    }

    const apiKey = process.env.DATATRACE_API_KEY
    if (!apiKey) {
      await ctx.runMutation(internal.titleSearchOrders._markFailed, {
        orderId,
        failureMessage: 'DATATRACE_API_KEY missing at placement time',
      })
      return null
    }
    const callbackBase =
      process.env.DATATRACE_CALLBACK_BASE_URL ?? process.env.CONVEX_SITE_URL
    if (!callbackBase) {
      await ctx.runMutation(internal.titleSearchOrders._markFailed, {
        orderId,
        failureMessage: 'callback base URL not configured',
      })
      return null
    }
    const callbackUrl = `${callbackBase.replace(/\/$/, '')}/integrations/datatrace/delivery?orderId=${order._id}`

    try {
      const res = await fetch(`${DATATRACE_BASE}/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          product: 'tps_full_title',
          reference: order.vendorReference,
          property: {
            line1: order.queryAddress.line1,
            line2: order.queryAddress.line2 ?? null,
            city: order.queryAddress.city,
            state: order.queryAddress.state,
            zip: order.queryAddress.zip,
          },
          callback: {
            url: callbackUrl,
            secret: order.callbackToken,
          },
        }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        await ctx.runMutation(internal.titleSearchOrders._markFailed, {
          orderId,
          failureMessage: `vendor HTTP ${res.status}: ${body.slice(0, 200)}`,
        })
        return null
      }
      const json = (await res.json()) as {
        orderId?: string
        message?: string
      }
      await ctx.runMutation(internal.titleSearchOrders._markInProgress, {
        orderId,
        vendorOrderId: json.orderId,
        message: json.message ?? 'Order acknowledged.',
      })
      return null
    } catch (err) {
      await ctx.runMutation(internal.titleSearchOrders._markFailed, {
        orderId,
        failureMessage: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  },
})

// Mock delivery — emits a tiny placeholder PDF the same way a live webhook
// would. Stores a Blob, then funnels through the same `_attachDeliveredPdf`
// mutation the real path uses.
export const deliverMockOrder = internalAction({
  args: { orderId: v.id('titleSearchOrders') },
  handler: async (ctx, { orderId }): Promise<null> => {
    const order: Doc<'titleSearchOrders'> | null = await ctx.runQuery(
      internal.titleSearchOrders._loadForPlacement,
      { orderId }
    )
    if (!order || order.status !== 'in_progress') return null

    // Minimal PDF header so the bytes look like a PDF if anything sniffs
    // them. We don't go through the real extractor for mock orders — the
    // payload is synthesized in `_attachDeliveredPdf` — so a parseable PDF
    // body would be wasted work.
    const text =
      `%PDF-1.4\n` +
      `% [MOCK] DataTrace TPS Full Title\n` +
      `% Property: ${order.queryAddress.line1}, ${order.queryAddress.city}, ${order.queryAddress.state} ${order.queryAddress.zip}\n` +
      `% Order: ${order._id}\n` +
      `% Generated: ${new Date().toISOString()}\n` +
      `%%EOF\n`
    const blob = new Blob([text], { type: 'application/pdf' })
    const storageId = await ctx.storage.store(blob)

    try {
      await ctx.runMutation(
        internal.titleSearchOrders._attachDeliveredPdf,
        {
          orderId,
          storageId,
          sizeBytes: blob.size,
          contentType: 'application/pdf',
        }
      )
    } catch (err) {
      try {
        await ctx.storage.delete(storageId)
      } catch {
        /* best-effort */
      }
      await ctx.runMutation(internal.titleSearchOrders._markFailed, {
        orderId,
        failureMessage: err instanceof Error ? err.message : String(err),
      })
    }
    return null
  },
})

// Live delivery — called by the HTTP webhook after it has verified the
// per-order HMAC signature. Downloads the vendor's signed download URL,
// stores the bytes, and attaches the document.
export const receiveDeliveryAction = internalAction({
  args: {
    orderId: v.id('titleSearchOrders'),
    downloadUrl: v.string(),
  },
  handler: async (ctx, { orderId, downloadUrl }): Promise<null> => {
    let storageId: Id<'_storage'> | null = null
    try {
      const res = await fetch(downloadUrl)
      if (!res.ok) {
        await ctx.runMutation(internal.titleSearchOrders._markFailed, {
          orderId,
          failureMessage: `delivery download HTTP ${res.status}`,
        })
        return null
      }
      const buf = await res.arrayBuffer()
      const bytes = new Uint8Array(buf)
      if (bytes.byteLength === 0) {
        await ctx.runMutation(internal.titleSearchOrders._markFailed, {
          orderId,
          failureMessage: 'delivery download empty body',
        })
        return null
      }
      const sha256 = await hexSha256(bytes)
      const blob = new Blob([buf], {
        type: res.headers.get('Content-Type') ?? 'application/pdf',
      })
      storageId = await ctx.storage.store(blob)
      await ctx.runMutation(
        internal.titleSearchOrders._attachDeliveredPdf,
        {
          orderId,
          storageId,
          sizeBytes: bytes.byteLength,
          contentType: res.headers.get('Content-Type') ?? undefined,
          sha256,
        }
      )
      return null
    } catch (err) {
      if (storageId) {
        try {
          await ctx.storage.delete(storageId)
        } catch {
          /* best-effort */
        }
      }
      await ctx.runMutation(internal.titleSearchOrders._markFailed, {
        orderId,
        failureMessage: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  },
})
