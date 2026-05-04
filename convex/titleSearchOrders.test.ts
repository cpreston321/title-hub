/// <reference types="vite/client" />
//
// Lifecycle tests for `titleSearchOrders`. Drives the public API + the
// HTTP webhook the same way a real client would. With no DATATRACE_API_KEY
// the place mutation routes to vendor='mock', which schedules a delayed
// mock delivery — fake timers + finishAllScheduledFunctions drain the
// whole place→deliver→reconcile chain.

import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import schema from './schema'
import {
  createOrganizationAsUser,
  makeBetterAuthUser,
  registerLocalBetterAuth,
} from './lib/testHelpers'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')
const betterAuthModules = import.meta.glob('./betterAuth/**/*.ts')

async function setup() {
  const t = convexTest(schema, modules)
  registerLocalBetterAuth(t, betterAuthModules)
  await t.mutation(api.seed.indiana, {})

  const alice = await makeBetterAuthUser(t, 'alice@a.example', 'Alice')
  await createOrganizationAsUser(t, alice.userId, alice.sessionId, {
    slug: 'agency-a',
    name: 'Agency A LLC',
  })

  const counties = await t.run((ctx) => ctx.db.query('counties').take(200))
  const marion = counties.find((c) => c.fipsCode === '18097')!

  const created = await alice.asUser.mutation(api.files.create, {
    fileNumber: 'TS-2026-001',
    countyId: marion._id,
    transactionType: 'purchase',
    propertyAddress: {
      line1: '5215 E Washington St',
      city: 'Indianapolis',
      state: 'IN',
      zip: '46219',
    },
  })

  return { t, alice, fileId: created.fileId }
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message)
  )
  return Array.from(new Uint8Array(sig), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
}

describe('titleSearchOrders lifecycle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('place → mock → delivery happy path', async () => {
    const { t, alice, fileId } = await setup()

    const { orderId, vendor } = await alice.asUser.mutation(
      api.titleSearchOrders.place,
      { fileId }
    )
    expect(vendor).toBe('mock')

    // Drain placeOrderAction (runs immediately, marks in_progress + schedules
    // deliverMockOrder for +30s) and the delayed delivery action itself.
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    const orders = await alice.asUser.query(
      api.titleSearchOrders.listForFile,
      { fileId }
    )
    expect(orders).toHaveLength(1)
    expect(orders[0]._id).toBe(orderId)
    expect(orders[0].status).toBe('delivered')
    expect(orders[0].vendorOrderId).toBe(`MOCK-${orderId}`)
    expect(orders[0].deliveryDocumentId).toBeTruthy()

    // Documents row was created with docType `title_search`.
    const docs = await t.run((ctx) =>
      ctx.db.query('documents').collect()
    )
    expect(docs).toHaveLength(1)
    expect(docs[0].docType).toBe('title_search')
    expect(docs[0]._id).toBe(orders[0].deliveryDocumentId)

    // Synthetic succeeded extraction (mock branch, not scheduled through
    // the Claude runner). Reconciliation ran off the back of it.
    const extractions = await t.run((ctx) =>
      ctx.db.query('documentExtractions').collect()
    )
    expect(extractions).toHaveLength(1)
    expect(extractions[0]).toMatchObject({
      status: 'succeeded',
      source: 'mock',
      documentId: docs[0]._id,
    })
    expect(extractions[0].payload).toMatchObject({
      documentKind: 'title_search',
    })

    // Audit trail records placed → in_progress → delivered.
    const events = await alice.asUser.query(api.audit.listForFile, { fileId })
    const actions = events.map((e) => e.action)
    expect(actions).toContain('title_search_order.placed')
    expect(actions).toContain('title_search_order.in_progress')
    expect(actions).toContain('title_search_order.delivered')

    // Bell notification fired on delivery, with severity 'ok'.
    const notifications = await alice.asUser.query(
      api.notifications.listForMe,
      {}
    )
    const delivered = notifications.find(
      (n) => n.kind === 'title_search.delivered'
    )
    expect(delivered).toBeDefined()
    expect(delivered!.severity).toBe('ok')
    expect(delivered!.fileId).toBe(fileId)

    // File status auto-promoted opened → in_exam on delivery (mock parity
    // with the live extraction path).
    const file = await t.run((ctx) => ctx.db.get(fileId))
    expect(file!.status).toBe('in_exam')
  })

  test('double place rejected with TITLE_SEARCH_ALREADY_IN_FLIGHT', async () => {
    const { alice, fileId } = await setup()
    await alice.asUser.mutation(api.titleSearchOrders.place, { fileId })
    // Second place fires while the first is still requested/in_progress.
    await expect(
      alice.asUser.mutation(api.titleSearchOrders.place, { fileId })
    ).rejects.toThrow(/TITLE_SEARCH_ALREADY_IN_FLIGHT/)
  })

  test('a second place is allowed after the prior order resolves', async () => {
    const { t, alice, fileId } = await setup()
    await alice.asUser.mutation(api.titleSearchOrders.place, { fileId })
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    // Prior order is now `delivered` — a new one should slot in.
    const second = await alice.asUser.mutation(api.titleSearchOrders.place, {
      fileId,
    })
    expect(second.orderId).toBeDefined()
  })

  test('cancel before delivery short-circuits the mock delivery', async () => {
    const { t, alice, fileId } = await setup()
    const { orderId } = await alice.asUser.mutation(
      api.titleSearchOrders.place,
      { fileId }
    )

    // Run placeOrderAction so the order is in_progress + the +30s
    // deliverMockOrder is queued. We cancel before the delivery fires.
    await vi.runOnlyPendingTimersAsync()

    await alice.asUser.mutation(api.titleSearchOrders.cancel, {
      orderId,
      reason: 'no longer needed',
    })

    // Now drain everything else. deliverMockOrder fires but bails on
    // status !== 'in_progress', so no delivery state is written.
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    const orders = await alice.asUser.query(
      api.titleSearchOrders.listForFile,
      { fileId }
    )
    expect(orders[0].status).toBe('cancelled')
    expect(orders[0].deliveryDocumentId).toBeNull()

    const docs = await t.run((ctx) =>
      ctx.db.query('documents').collect()
    )
    expect(docs).toHaveLength(0)
  })

  test('duplicate _attachDeliveredPdf is idempotent + cleans up the second blob', async () => {
    const { t, alice, fileId } = await setup()
    const { orderId } = await alice.asUser.mutation(
      api.titleSearchOrders.place,
      { fileId }
    )
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    const orders = await alice.asUser.query(
      api.titleSearchOrders.listForFile,
      { fileId }
    )
    expect(orders[0].status).toBe('delivered')
    const originalDocumentId = orders[0].deliveryDocumentId!

    // Simulate a redelivered webhook landing a second time.
    const replayStorageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(['replay'], { type: 'application/pdf' }))
    )
    const result = await t.mutation(
      internal.titleSearchOrders._attachDeliveredPdf,
      {
        orderId,
        storageId: replayStorageId,
        sizeBytes: 6,
        contentType: 'application/pdf',
      }
    )
    expect(result.deduped).toBe(true)
    expect(result.documentId).toBe(originalDocumentId)

    // Replay blob was discarded.
    const meta = await t.run((ctx) =>
      ctx.db.system.get(replayStorageId)
    )
    expect(meta).toBeNull()

    // Still exactly one documents row.
    const docs = await t.run((ctx) =>
      ctx.db.query('documents').collect()
    )
    expect(docs).toHaveLength(1)
  })

  test('webhook rejects a bad signature with 401', async () => {
    const { t, alice, fileId } = await setup()
    const { orderId } = await alice.asUser.mutation(
      api.titleSearchOrders.place,
      { fileId }
    )
    // Drain placeOrderAction so the order has its callbackToken settled
    // (it's set at insert time, but draining keeps the test's mental model
    // honest — we send the webhook against a real, in-progress order).
    await vi.runOnlyPendingTimersAsync()

    const ts = String(Date.now())
    const res = await t.fetch(
      `/integrations/datatrace/delivery?orderId=${orderId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Title-Timestamp': ts,
          'X-Title-Signature': 'sha256=' + 'a'.repeat(64),
        },
        body: JSON.stringify({ status: 'in_progress' }),
      }
    )
    expect(res.status).toBe(401)

    // Order state did not change.
    const after = await alice.asUser.query(
      api.titleSearchOrders.listForFile,
      { fileId }
    )
    expect(after[0].status).toBe('in_progress')
  })

  test('webhook accepts a correctly-signed in_progress callback', async () => {
    const { t, alice, fileId } = await setup()
    const { orderId } = await alice.asUser.mutation(
      api.titleSearchOrders.place,
      { fileId }
    )
    await vi.runOnlyPendingTimersAsync()

    const callbackToken = await t.run(async (ctx) => {
      const o = await ctx.db.get(orderId as Id<'titleSearchOrders'>)
      return o!.callbackToken
    })

    const rawBody = JSON.stringify({
      status: 'in_progress',
      vendorOrderId: 'DT-LIVE-42',
      message: 'Examiner picked up the order',
    })
    const ts = String(Date.now())
    const sig = await hmacHex(callbackToken, `${ts}.${rawBody}`)
    const res = await t.fetch(
      `/integrations/datatrace/delivery?orderId=${orderId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Title-Timestamp': ts,
          'X-Title-Signature': `sha256=${sig}`,
        },
        body: rawBody,
      }
    )
    expect(res.status).toBe(200)

    const after = await alice.asUser.query(
      api.titleSearchOrders.listForFile,
      { fileId }
    )
    // vendorOrderId from the callback overrides the placeholder MOCK- one.
    expect(after[0].vendorOrderId).toBe('DT-LIVE-42')
    // Vendor message log captured the note.
    expect(
      after[0].vendorMessages.some((m) =>
        m.message.includes('Examiner picked up')
      )
    ).toBe(true)
  })

  test('vendor-reported failure fires a warn notification + audit', async () => {
    const { t, alice, fileId } = await setup()
    const { orderId } = await alice.asUser.mutation(
      api.titleSearchOrders.place,
      { fileId }
    )
    // Drain placeOrderAction so the order is in_progress with a callbackToken.
    await vi.runOnlyPendingTimersAsync()

    const callbackToken = await t.run(async (ctx) => {
      const o = await ctx.db.get(orderId as Id<'titleSearchOrders'>)
      return o!.callbackToken
    })

    const rawBody = JSON.stringify({
      status: 'failed',
      message: 'Property not found in title plant',
    })
    const ts = String(Date.now())
    const sig = await hmacHex(callbackToken, `${ts}.${rawBody}`)
    const res = await t.fetch(
      `/integrations/datatrace/delivery?orderId=${orderId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Title-Timestamp': ts,
          'X-Title-Signature': `sha256=${sig}`,
        },
        body: rawBody,
      }
    )
    expect(res.status).toBe(200)

    const orders = await alice.asUser.query(
      api.titleSearchOrders.listForFile,
      { fileId }
    )
    expect(orders[0].status).toBe('failed')
    expect(orders[0].failureMessage).toContain('Property not found')

    const notifications = await alice.asUser.query(
      api.notifications.listForMe,
      {}
    )
    const failed = notifications.find(
      (n) => n.kind === 'title_search.failed'
    )
    expect(failed).toBeDefined()
    expect(failed!.severity).toBe('warn')

    const events = await alice.asUser.query(api.audit.listForFile, { fileId })
    const actions = events.map((e) => e.action)
    expect(actions).toContain('title_search_order.failed')
  })
})

describe('purgeOldOrders retention', () => {
  test('drops terminal-state orders past the retention horizon', async () => {
    const { t, alice, fileId } = await setup()
    const tenantId = await t.run(async (ctx) => {
      const f = await ctx.db.get(fileId)
      return f!.tenantId
    })

    // Inject three orders with old requestedAt: one delivered, one failed,
    // one cancelled — all should be purged. Plus one fresh delivered row
    // that should survive, and one in-flight row (also fresh) that survives
    // because non-terminal.
    const oldTs = Date.now() - 400 * 24 * 60 * 60 * 1000
    const freshTs = Date.now() - 30 * 24 * 60 * 60 * 1000

    const make = async (
      status: 'delivered' | 'failed' | 'cancelled' | 'in_progress',
      requestedAt: number
    ): Promise<Id<'titleSearchOrders'>> =>
      await t.run(async (ctx) => {
        const m = await ctx.db
          .query('tenantMembers')
          .withIndex('by_tenant_email', (q) => q.eq('tenantId', tenantId))
          .first()
        return await ctx.db.insert('titleSearchOrders', {
          tenantId,
          fileId,
          vendor: 'mock',
          product: 'tps_full_title',
          status,
          requestedByMemberId: m!._id,
          requestedAt,
          queryAddress: {
            line1: '5215 E Washington St',
            city: 'Indianapolis',
            state: 'IN',
            zip: '46219',
          },
          callbackToken: 'tok',
          vendorMessages: [],
        })
      })

    const oldDelivered = await make('delivered', oldTs)
    const oldFailed = await make('failed', oldTs)
    const oldCancelled = await make('cancelled', oldTs)
    const freshDelivered = await make('delivered', freshTs)
    const freshInFlight = await make('in_progress', oldTs) // old but non-terminal

    const result = await t.mutation(
      internal.titleSearchOrders.purgeOldOrders,
      {}
    )
    expect(result.deleted).toBe(3)
    expect(result.rescheduled).toBe(false)

    const survivors = await alice.asUser.query(
      api.titleSearchOrders.listForFile,
      { fileId }
    )
    const ids = survivors.map((o) => o._id)
    expect(ids).toEqual(
      expect.arrayContaining([freshDelivered, freshInFlight])
    )
    expect(ids).not.toContain(oldDelivered)
    expect(ids).not.toContain(oldFailed)
    expect(ids).not.toContain(oldCancelled)
  })
})
