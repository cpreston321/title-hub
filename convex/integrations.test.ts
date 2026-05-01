/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import schema from './schema'
import {
  createOrganizationAsUser,
  makeBetterAuthUser,
  registerLocalBetterAuth,
} from './lib/testHelpers'

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

  return { t, alice }
}

describe('Sprint 6 integrations foundation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('admin can create + list a mock integration', async () => {
    const { alice } = await setup()

    const { integrationId } = await alice.asUser.mutation(
      api.integrations.create,
      { kind: 'mock', name: 'Mock SoftPro' }
    )
    expect(integrationId).toBeDefined()

    const list = await alice.asUser.query(api.integrations.list, {})
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      kind: 'mock',
      name: 'Mock SoftPro',
      status: 'active',
      filesSyncedTotal: 0,
      hasCredentials: false,
    })
  })

  test('non-admin cannot create an integration', async () => {
    const { t, alice } = await setup()

    // Demote alice to processor.
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query('tenantMembers')
        .withIndex('by_betterAuthUser', (q) =>
          q.eq('betterAuthUserId', alice.userId)
        )
        .unique()
      if (member) await ctx.db.patch(member._id, { role: 'processor' })
    })

    await expect(
      alice.asUser.mutation(api.integrations.create, {
        kind: 'mock',
        name: 'X',
      })
    ).rejects.toThrow(/FORBIDDEN/)
  })

  test('manual sync upserts files from the mock adapter end-to-end', async () => {
    const { t, alice } = await setup()

    const { integrationId } = await alice.asUser.mutation(
      api.integrations.create,
      { kind: 'mock', name: 'Mock A' }
    )

    await alice.asUser.mutation(api.integrations.runSync, { integrationId })

    // Scheduled action runs synchronously inside convex-test.
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    // Files should now exist for the seeded mock data (3 fixtures).
    const files = await alice.asUser.query(api.files.list, {})
    const numbers = files.map((f) => f.fileNumber).sort()
    expect(numbers).toEqual(['MOCK-2026-001', 'MOCK-2026-002', 'MOCK-2026-003'])

    // Integration row reflects the run.
    const view = await alice.asUser.query(api.integrations.get, {
      integrationId,
    })
    expect(view.integration.lastSyncStatus).toBe('succeeded')
    expect(view.integration.filesSyncedTotal).toBe(3)
    expect(view.recentRuns).toHaveLength(1)
    expect(view.recentRuns[0]).toMatchObject({
      status: 'succeeded',
      filesProcessed: 3,
      filesUpserted: 3,
      errorCount: 0,
      trigger: 'manual',
    })
  })

  test('a second sync is idempotent — no duplicate file rows', async () => {
    const { t, alice } = await setup()

    const { integrationId } = await alice.asUser.mutation(
      api.integrations.create,
      { kind: 'mock', name: 'Mock A' }
    )
    await alice.asUser.mutation(api.integrations.runSync, { integrationId })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    await alice.asUser.mutation(api.integrations.runSync, { integrationId })
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    const files = await alice.asUser.query(api.files.list, {})
    expect(files).toHaveLength(3)
  })

  test('disabling an integration blocks runSync', async () => {
    const { alice } = await setup()
    const { integrationId } = await alice.asUser.mutation(
      api.integrations.create,
      { kind: 'mock', name: 'Mock A' }
    )
    await alice.asUser.mutation(api.integrations.setEnabled, {
      integrationId,
      enabled: false,
    })
    await expect(
      alice.asUser.mutation(api.integrations.runSync, { integrationId })
    ).rejects.toThrow(/INTEGRATION_DISABLED/)
  })

  test('revealInboundSecret surfaces the HMAC secret to admins only', async () => {
    const { alice } = await setup()
    const { integrationId } = await alice.asUser.mutation(
      api.integrations.create,
      { kind: 'softpro_360', name: 'SoftPro Prod' }
    )
    const { inboundSecret } = await alice.asUser.mutation(
      api.integrations.revealInboundSecret,
      { integrationId }
    )
    expect(inboundSecret).toMatch(/^[a-f0-9]{64}$/)

    // The secret never appears on the public list shape.
    const list = await alice.asUser.query(api.integrations.list, {})
    expect(JSON.stringify(list)).not.toContain(inboundSecret)
  })

  // Replaced by the more specific "runSync on a push-mode integration"
  // test below now that softpro_standard is push-mode.

  test('softpro_standard is push-mode: list shape exposes mode + agentStale', async () => {
    const { alice } = await setup()
    await alice.asUser.mutation(api.integrations.create, {
      kind: 'softpro_standard',
      name: 'Standard agent',
    })
    const list = await alice.asUser.query(api.integrations.list, {})
    expect(list[0]).toMatchObject({
      kind: 'softpro_standard',
      mode: 'push',
      agentLastHeartbeatAt: null,
      agentVersion: null,
      agentStale: true,
    })
  })

  test('agent push: snapshots upsert files and update watermark', async () => {
    const { t, alice } = await setup()
    const { integrationId } = await alice.asUser.mutation(
      api.integrations.create,
      { kind: 'softpro_standard', name: 'Standard' }
    )

    const result = await t.mutation(internal.integrations._agentPushSnapshots, {
      integrationId,
      watermark: 'rowversion:0x000A',
      snapshots: [
        {
          externalId: 'QT-2026-0001',
          fileNumber: 'QT-2026-0001',
          externalStatus: 'in_exam',
          stateCode: 'IN',
          countyFips: '18097',
          transactionType: 'purchase',
          propertyAddress: {
            line1: '100 N Main',
            city: 'Indianapolis',
            state: 'IN',
            zip: '46204',
          },
          parties: [
            { role: 'buyer', legalName: 'Bob B.', partyType: 'person' },
          ],
          updatedAt: 1_730_000_000_000,
        },
      ],
    })
    expect(result).toMatchObject({
      filesProcessed: 1,
      filesUpserted: 1,
      errorCount: 0,
    })

    const files = await alice.asUser.query(api.files.list, {})
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({
      fileNumber: 'QT-2026-0001',
      externalRefs: { softproId: 'QT-2026-0001' },
    })

    const view = await alice.asUser.query(api.integrations.get, {
      integrationId,
    })
    expect(view.integration.agentWatermark).toBe('rowversion:0x000A')
    expect(view.integration.lastSyncStatus).toBe('succeeded')
    expect(view.integration.filesSyncedTotal).toBe(1)
  })

  test('agent push refuses pull-mode kinds', async () => {
    const { t, alice } = await setup()
    const { integrationId } = await alice.asUser.mutation(
      api.integrations.create,
      { kind: 'mock', name: 'Pull-mode' }
    )
    await expect(
      t.mutation(internal.integrations._agentPushSnapshots, {
        integrationId,
        snapshots: [],
      })
    ).rejects.toThrow(/INTEGRATION_NOT_PUSH_MODE/)
  })

  test('agent heartbeat clears agentStale on the dashboard view', async () => {
    const { t, alice } = await setup()
    const { integrationId } = await alice.asUser.mutation(
      api.integrations.create,
      { kind: 'softpro_standard', name: 'Standard' }
    )
    await t.mutation(internal.integrations._agentRecordHeartbeat, {
      integrationId,
      agentVersion: '0.1.0',
      hostname: 'DESKTOP-A',
    })
    const list = await alice.asUser.query(api.integrations.list, {})
    expect(list[0]).toMatchObject({
      agentStale: false,
      agentVersion: '0.1.0',
      agentHostname: 'DESKTOP-A',
    })
    expect(list[0].agentLastHeartbeatAt).toBeGreaterThan(0)
  })

  test('runSync on a push-mode integration records a fail-fast run', async () => {
    const { t, alice } = await setup()
    const { integrationId } = await alice.asUser.mutation(
      api.integrations.create,
      { kind: 'softpro_standard', name: 'Standard' }
    )
    await alice.asUser.mutation(api.integrations.runSync, { integrationId })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    const view = await alice.asUser.query(api.integrations.get, {
      integrationId,
    })
    expect(view.integration.lastSyncStatus).toBe('failed')
    expect(view.recentRuns[0].errorSample ?? '').toMatch(/push-mode/)
  })

  test('agentInstallInfo: admin can read inboundSecret for the agent', async () => {
    const { alice } = await setup()
    const { integrationId } = await alice.asUser.mutation(
      api.integrations.create,
      { kind: 'softpro_standard', name: 'Standard' }
    )
    const info = await alice.asUser.mutation(
      api.integrations.agentInstallInfo,
      {
        integrationId,
      }
    )
    expect(info).toMatchObject({ integrationId })
    expect(info.inboundSecret).toMatch(/^[a-f0-9]{64}$/)
  })

  test('agentInstallInfo refuses pull-mode kinds', async () => {
    const { alice } = await setup()
    const { integrationId } = await alice.asUser.mutation(
      api.integrations.create,
      { kind: 'mock', name: 'Pull-mode' }
    )
    await expect(
      alice.asUser.mutation(api.integrations.agentInstallInfo, {
        integrationId,
      })
    ).rejects.toThrow(/INTEGRATION_NOT_PUSH_MODE/)
  })

  test("cross-tenant isolation: tenant B cannot see tenant A's integrations", async () => {
    const { t, alice } = await setup()
    await alice.asUser.mutation(api.integrations.create, {
      kind: 'mock',
      name: "A's Mock",
    })

    const bob = await makeBetterAuthUser(t, 'bob@b.example', 'Bob')
    await createOrganizationAsUser(t, bob.userId, bob.sessionId, {
      slug: 'agency-b',
      name: 'Agency B LLC',
    })

    const bobsList = await bob.asUser.query(api.integrations.list, {})
    expect(bobsList).toHaveLength(0)
  })
})
