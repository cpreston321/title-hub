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
  await createOrganizationAsUser(t, alice.userId, alice.sessionId, {
    slug: 'agency-a',
    name: 'Agency A LLC',
  })
  await alice.asUser.mutation(api.rules.seedPilotRules, {})

  const counties = await t.run((ctx) => ctx.db.query('counties').take(200))
  const marion = counties.find((c) => c.fipsCode === '18097')!
  const hamilton = counties.find((c) => c.fipsCode === '18057')!
  const boone = counties.find((c) => c.fipsCode === '18011')! // intentionally unseeded for rules

  return { t, alice, marion, hamilton, boone }
}

describe('Sprint 3 county recording rules', () => {
  test('seedPilotRules creates rules for Marion + Hamilton across 5 doc types', async () => {
    const { alice, marion, hamilton } = await setup()

    const marionRules = await alice.asUser.query(api.rules.listForCounty, {
      countyId: marion._id,
    })
    const hamiltonRules = await alice.asUser.query(api.rules.listForCounty, {
      countyId: hamilton._id,
    })

    expect(marionRules).toHaveLength(5)
    expect(hamiltonRules).toHaveLength(5)
    expect(
      marionRules.map((r: { docType: string }) => r.docType).sort()
    ).toEqual(['assignment', 'deed', 'deed_of_trust', 'mortgage', 'release'])
  })

  test('Marion resolves a real deed rule set', async () => {
    const { alice, marion } = await setup()
    const rule = await alice.asUser.query(api.rules.resolveForCounty, {
      countyId: marion._id,
      docType: 'deed',
    })
    expect(rule).not.toBeNull()
    expect(rule!.rules.pageSize).toBe('letter')
    expect(rule!.rules.requiredExhibits).toContain('sales_disclosure_form')
    expect(rule!.rules.feeSchedule.firstPage).toBe(25)
    expect(rule!.version).toBe(1)
  })

  test('an unseeded county returns null (rules not configured)', async () => {
    const { alice, boone } = await setup()
    const rule = await alice.asUser.query(api.rules.resolveForCounty, {
      countyId: boone._id,
      docType: 'deed',
    })
    expect(rule).toBeNull()
  })

  test("opening a file in Marion resolves rules at the file's openedAt", async () => {
    const { alice, marion } = await setup()
    const created = await alice.asUser.mutation(api.files.create, {
      fileNumber: 'QT-MAR-1',
      countyId: marion._id,
      transactionType: 'purchase',
    })
    const rule = await alice.asUser.query(api.rules.resolveForFile, {
      fileId: created.fileId,
      docType: 'deed',
    })
    expect(rule).not.toBeNull()
    expect(rule!.rules.pageSize).toBe('letter')
  })

  test('publishRule with supersedes closes out the prior version', async () => {
    const { alice, marion } = await setup()
    const before = await alice.asUser.query(api.rules.resolveForCounty, {
      countyId: marion._id,
      docType: 'deed',
    })
    expect(before).not.toBeNull()

    const newEffective = before!.effectiveFrom + 30 * 24 * 60 * 60 * 1000 // +30d

    const { ruleId, version } = await alice.asUser.mutation(
      api.rules.publishRule,
      {
        countyId: marion._id,
        docType: 'deed',
        effectiveFrom: newEffective,
        supersedes: before!._id,
        rules: {
          pageSize: 'letter',
          margins: { top: 3, bottom: 1, left: 1, right: 1 },
          requiredExhibits: [
            'legal_description',
            'sales_disclosure_form',
            'transfer_tax_receipt',
          ],
          feeSchedule: {
            firstPage: 30,
            additionalPage: 5,
            salesDisclosureFee: 25,
          },
          signaturePageRequirements: {
            notarized: true,
            witnessRequired: false,
            printedNameBeneathSignature: true,
          },
          notaryRequirements: {
            sealRequired: true,
            commissionExpirationStatement: true,
          },
        },
      }
    )
    expect(version).toBe(2)
    expect(ruleId).toBeTruthy()

    // A file opened before the new rule still resolves to v1
    const beforeChange = newEffective - 1
    const earlyRule = await alice.asUser.query(api.rules.resolveForCounty, {
      countyId: marion._id,
      docType: 'deed',
      asOf: beforeChange,
    })
    expect(earlyRule!.version).toBe(1)
    expect(earlyRule!.rules.feeSchedule.firstPage).toBe(25)

    // A file opened after picks up v2
    const lateRule = await alice.asUser.query(api.rules.resolveForCounty, {
      countyId: marion._id,
      docType: 'deed',
      asOf: newEffective + 1000,
    })
    expect(lateRule!.version).toBe(2)
    expect(lateRule!.rules.feeSchedule.firstPage).toBe(30)
  })

  test('non-owner cannot publish rules (FORBIDDEN)', async () => {
    const { t, alice, marion } = await setup()
    // Demote alice to admin (not owner)
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query('tenantMembers')
        .withIndex('by_betterAuthUser', (q) =>
          q.eq('betterAuthUserId', alice.userId)
        )
        .unique()
      if (m) await ctx.db.patch(m._id, { role: 'admin' })
    })
    await expect(
      alice.asUser.mutation(api.rules.publishRule, {
        countyId: marion._id,
        docType: 'deed',
        effectiveFrom: Date.now() + 1000,
        rules: {
          pageSize: 'letter',
          requiredExhibits: [],
          feeSchedule: {},
          signaturePageRequirements: {},
          notaryRequirements: {},
        },
      })
    ).rejects.toThrow(/FORBIDDEN/)
  })
})
