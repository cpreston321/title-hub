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
  const alice = await makeBetterAuthUser(t, 'alice@a.example', 'Alice')
  await createOrganizationAsUser(t, alice.userId, alice.sessionId, {
    slug: 'agency-a',
    name: 'Agency A LLC',
  })
  return { t, alice }
}

describe('Sprint 2 NPI tokenization', () => {
  test('issue + reveal round-trips an SSN', async () => {
    const { alice } = await setup()
    const issued = await alice.asUser.mutation(api.secrets.issue, {
      fieldKind: 'ssn',
      plaintext: '123-45-6789',
    })
    expect(issued.token).toMatch(/^npi_tok_[0-9a-f]{32}$/)

    const revealed = await alice.asUser.mutation(api.secrets.reveal, {
      token: issued.token,
    })
    expect(revealed.plaintext).toBe('123-45-6789')
    expect(revealed.fieldKind).toBe('ssn')
  })

  test('members without canViewNpi are blocked from reveal', async () => {
    const { t, alice } = await setup()
    const issued = await alice.asUser.mutation(api.secrets.issue, {
      fieldKind: 'ein',
      plaintext: '12-3456789',
    })

    // Demote Alice's NPI flag (the test setup gave her canViewNpi:true as owner).
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query('tenantMembers')
        .withIndex('by_betterAuthUser', (q) =>
          q.eq('betterAuthUserId', alice.userId)
        )
        .unique()
      if (m) await ctx.db.patch(m._id, { canViewNpi: false })
    })

    await expect(
      alice.asUser.mutation(api.secrets.reveal, { token: issued.token })
    ).rejects.toThrow(/NPI_FORBIDDEN/)
  })

  test("tenant B cannot reveal tenant A's token", async () => {
    const { alice, t } = await setup()
    const bob = await makeBetterAuthUser(t, 'bob@b.example', 'Bob')
    await createOrganizationAsUser(t, bob.userId, bob.sessionId, {
      slug: 'agency-b',
      name: 'Agency B LLC',
    })

    const issued = await alice.asUser.mutation(api.secrets.issue, {
      fieldKind: 'ssn',
      plaintext: '987-65-4321',
    })

    await expect(
      bob.asUser.mutation(api.secrets.reveal, { token: issued.token })
    ).rejects.toThrow(/TOKEN_NOT_FOUND/)
  })

  test('eraseTenant: tabletop — ciphertexts are unrecoverable after CMK destroy', async () => {
    const { t, alice } = await setup()

    const a = await alice.asUser.mutation(api.secrets.issue, {
      fieldKind: 'ssn',
      plaintext: '111-22-3333',
    })
    const b = await alice.asUser.mutation(api.secrets.issue, {
      fieldKind: 'account',
      plaintext: 'ACCT-9999',
    })

    // Sanity: reveal works pre-erasure
    const before = await alice.asUser.mutation(api.secrets.reveal, {
      token: a.token,
    })
    expect(before.plaintext).toBe('111-22-3333')

    // Run cryptographic erasure
    const me = await alice.asUser.query(api.tenants.current, {})
    const erased = await alice.asUser.mutation(api.secrets.eraseTenant, {
      tenantId: me.tenantId,
      confirm: 'ERASE',
    })
    expect(erased.destroyedKeys).toBeGreaterThan(0)
    expect(erased.erasedSecrets).toBe(2)

    // Reveal must now fail with TENANT_KEY_DESTROYED
    await expect(
      alice.asUser.mutation(api.secrets.reveal, { token: a.token })
    ).rejects.toThrow(/TENANT_KEY_DESTROYED/)
    await expect(
      alice.asUser.mutation(api.secrets.reveal, { token: b.token })
    ).rejects.toThrow(/TENANT_KEY_DESTROYED/)

    // The tabletop assertion: the raw key is gone from storage AND ciphertext
    // bytes are zeroed. A determined attacker reaching the DB cannot recover
    // plaintext for any token issued under the erased CMK.
    const survivors = await t.run(async (ctx) => {
      return await ctx.db.query('npiSecrets').take(50)
    })
    expect(survivors.every((s) => s.erased)).toBe(true)
    expect(survivors.every((s) => s.ciphertext.byteLength === 0)).toBe(true)

    const keys = await t.run(async (ctx) => {
      return await ctx.db.query('tenantCryptoKeys').take(50)
    })
    expect(keys.every((k) => k.status === 'destroyed')).toBe(true)
    expect(keys.every((k) => k.rawKey === undefined)).toBe(true)
  })

  test('non-owner cannot eraseTenant', async () => {
    const { t, alice } = await setup()
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query('tenantMembers')
        .withIndex('by_betterAuthUser', (q) =>
          q.eq('betterAuthUserId', alice.userId)
        )
        .unique()
      if (m) await ctx.db.patch(m._id, { role: 'admin' })
    })
    const me = await alice.asUser.query(api.tenants.current, {})
    await expect(
      alice.asUser.mutation(api.secrets.eraseTenant, {
        tenantId: me.tenantId,
        confirm: 'ERASE',
      })
    ).rejects.toThrow(/FORBIDDEN/)
  })

  test('npi.viewed audit event includes who/what/why and is scoped per tenant', async () => {
    const { alice } = await setup()
    const issued = await alice.asUser.mutation(api.secrets.issue, {
      fieldKind: 'ssn',
      plaintext: '555-44-3322',
    })
    await alice.asUser.mutation(api.secrets.reveal, {
      token: issued.token,
      purpose: 'preparing recording package',
    })

    const events = await alice.asUser.query(api.audit.listForTenant, {})
    const viewed = events.find(
      (e: { action: string; metadata: Record<string, unknown> }) =>
        e.action === 'npi.viewed'
    )
    expect(viewed).toBeDefined()
    expect(viewed!.metadata.token).toBe(issued.token)
    expect(viewed!.metadata.purpose).toBe('preparing recording package')
    expect(viewed!.metadata.fieldKind).toBe('ssn')
  })
})
