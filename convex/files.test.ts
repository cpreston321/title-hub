/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
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
  const bob = await makeBetterAuthUser(t, 'bob@b.example', 'Bob')

  await createOrganizationAsUser(t, alice.userId, alice.sessionId, {
    slug: 'agency-a',
    name: 'Agency A LLC',
  })
  await createOrganizationAsUser(t, bob.userId, bob.sessionId, {
    slug: 'agency-b',
    name: 'Agency B LLC',
  })

  const counties = await t.run((ctx) => ctx.db.query('counties').take(200))
  const marion = counties.find((c) => c.fipsCode === '18097')!

  return { t, alice, bob, marion }
}

describe('Sprint 1 file isolation', () => {
  test('a file created by tenant A is not listed for tenant B', async () => {
    const { alice, bob, marion } = await setup()

    await alice.asUser.mutation(api.files.create, {
      fileNumber: 'QT-A-0001',
      countyId: marion._id,
      transactionType: 'purchase',
    })

    const aliceList = await alice.asUser.query(api.files.list, {})
    expect(aliceList).toHaveLength(1)
    expect(aliceList[0].fileNumber).toBe('QT-A-0001')

    const bobList = await bob.asUser.query(api.files.list, {})
    expect(bobList).toHaveLength(0)
  })

  test('tenant B cannot read a file created in tenant A by id', async () => {
    const { alice, bob, marion } = await setup()
    const created = await alice.asUser.mutation(api.files.create, {
      fileNumber: 'QT-A-0001',
      countyId: marion._id,
      transactionType: 'purchase',
    })

    await expect(
      bob.asUser.query(api.files.get, { fileId: created.fileId })
    ).rejects.toThrow(/FILE_NOT_FOUND/)
  })

  test('file numbers are unique per tenant but reusable across tenants', async () => {
    const { alice, bob, marion } = await setup()
    await alice.asUser.mutation(api.files.create, {
      fileNumber: 'QT-2026-1',
      countyId: marion._id,
      transactionType: 'purchase',
    })
    await expect(
      alice.asUser.mutation(api.files.create, {
        fileNumber: 'QT-2026-1',
        countyId: marion._id,
        transactionType: 'purchase',
      })
    ).rejects.toThrow(/FILE_NUMBER_TAKEN/)
    // Reusing across tenants is allowed:
    const ok = await bob.asUser.mutation(api.files.create, {
      fileNumber: 'QT-2026-1',
      countyId: marion._id,
      transactionType: 'purchase',
    })
    expect(ok.fileId).toBeTruthy()
  })

  test('party add and document upload write audit events; B sees nothing', async () => {
    const { t, alice, bob, marion } = await setup()
    const created = await alice.asUser.mutation(api.files.create, {
      fileNumber: 'QT-A-0002',
      countyId: marion._id,
      transactionType: 'purchase',
    })

    await alice.asUser.mutation(api.files.addParty, {
      fileId: created.fileId,
      partyType: 'person',
      legalName: 'Michelle Hicks',
      role: 'buyer',
    })

    // Inject a synthetic storage entry so we can call recordDocument without
    // actually uploading bytes through generateUploadUrl.
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob(['hello'], { type: 'text/plain' })
      )
    })

    await alice.asUser.mutation(api.files.recordDocument, {
      fileId: created.fileId,
      storageId,
      docType: 'purchase_agreement',
      title: 'PA - 3324 Corey Dr.pdf',
    })

    const aliceEvents = await alice.asUser.query(api.audit.listForFile, {
      fileId: created.fileId,
    })
    const actions = aliceEvents.map((e: { action: string }) => e.action).sort()
    expect(actions).toContain('file.created')
    expect(actions).toContain('file.party_added')
    expect(actions).toContain('document.uploaded')

    // Bob cannot see Alice's audit events: scoped to his own tenant,
    // so probing Alice's fileId returns an empty list.
    const bobView = await bob.asUser.query(api.audit.listForFile, {
      fileId: created.fileId,
    })
    expect(bobView).toHaveLength(0)

    // And Bob's tenant-wide audit feed only contains his own tenant lifecycle
    // events (tenant.created + member.added). It must NOT include any of
    // Alice's file/party/document events.
    const bobEvents = await bob.asUser.query(api.audit.listForTenant, {})
    const bobActions = bobEvents.map((e: { action: string }) => e.action)
    expect(bobActions).toEqual(
      expect.arrayContaining(['tenant.created', 'member.added'])
    )
    expect(bobActions).not.toContain('file.created')
    expect(bobActions).not.toContain('file.party_added')
    expect(bobActions).not.toContain('document.uploaded')
  })

  test('a closer role cannot create a file (FORBIDDEN)', async () => {
    const { t, alice, marion } = await setup()
    // Demote alice's membership to "closer" via direct DB write for this test.
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query('tenantMembers')
        .withIndex('by_betterAuthUser_tenant', (q) =>
          q.eq('betterAuthUserId', alice.userId)
        )
        .first()
      if (m) await ctx.db.patch(m._id, { role: 'closer' })
    })
    await expect(
      alice.asUser.mutation(api.files.create, {
        fileNumber: 'QT-A-X',
        countyId: marion._id,
        transactionType: 'purchase',
      })
    ).rejects.toThrow(/FORBIDDEN/)
  })
})
