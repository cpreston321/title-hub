/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import schema from "./schema"
import {
  createOrganizationAsUser,
  makeBetterAuthUser,
  registerLocalBetterAuth,
} from "./lib/testHelpers"

const modules = import.meta.glob("./**/*.ts")
const betterAuthModules = import.meta.glob("./betterAuth/**/*.ts")

describe("Better Auth organization-backed tenancy", () => {
  test("creating a Better Auth org provisions an app-side tenant + owner member", async () => {
    const t = convexTest(schema, modules)
    registerLocalBetterAuth(t, betterAuthModules)

    const alice = await makeBetterAuthUser(t, "alice@a.example", "Alice")
    await createOrganizationAsUser(t, alice.userId, alice.sessionId, {
      slug: "agency-a",
      name: "Agency A LLC",
    })

    const current = await alice.asUser.query(api.tenants.current, {})
    expect(current.role).toBe("owner")
    expect(current.legalName).toBe("Agency A LLC")
    expect(current.canViewNpi).toBe(true)
    expect(current.betterAuthOrgId).toBeTruthy()
  })

  test("listMine returns tenants the user belongs to", async () => {
    const t = convexTest(schema, modules)
    registerLocalBetterAuth(t, betterAuthModules)
    const alice = await makeBetterAuthUser(t, "alice@a.example", "Alice")
    await createOrganizationAsUser(t, alice.userId, alice.sessionId, {
      slug: "agency-a",
      name: "Agency A LLC",
    })

    const mine = await alice.asUser.query(api.tenants.listMine, {})
    expect(mine.memberships).toHaveLength(1)
    expect(mine.memberships[0].slug).toBe("agency-a")
    expect(mine.activeTenantId).toBe(mine.memberships[0].tenantId)
  })

  test("a user not a member of an org cannot resolve its tenant", async () => {
    const t = convexTest(schema, modules)
    registerLocalBetterAuth(t, betterAuthModules)

    const alice = await makeBetterAuthUser(t, "alice@a.example", "Alice")
    const bob = await makeBetterAuthUser(t, "bob@b.example", "Bob")

    await createOrganizationAsUser(t, alice.userId, alice.sessionId, {
      slug: "agency-a",
      name: "Agency A LLC",
    })

    // Bob has no active organization → NO_ACTIVE_TENANT
    await expect(
      bob.asUser.query(api.tenants.current, {}),
    ).rejects.toThrow(/NO_ACTIVE_TENANT/)

    // Now make Bob's session point at Alice's org (without adding him as a
    // member). requireTenant must reject as NOT_A_MEMBER.
    const aliceMine = await alice.asUser.query(api.tenants.listMine, {})
    const aliceOrgId = aliceMine.memberships[0].betterAuthOrgId!
    await t.run(async (ctx) =>
      ctx.runMutation(
        (await import("./_generated/api")).components.betterAuth.adapter
          .updateOne,
        {
          input: {
            model: "session",
            where: [{ field: "_id", value: bob.sessionId }],
            update: { activeOrganizationId: aliceOrgId },
          },
        },
      ),
    )
    await expect(
      bob.asUser.query(api.tenants.current, {}),
    ).rejects.toThrow(/NOT_A_MEMBER/)
  })

  test("an unauthenticated caller is rejected by tenants.current", async () => {
    const t = convexTest(schema, modules)
    registerLocalBetterAuth(t, betterAuthModules)
    await expect(t.query(api.tenants.current, {})).rejects.toThrow()
  })

  test("org-backed sign-up flow: user → org → file create works end-to-end", async () => {
    const t = convexTest(schema, modules)
    registerLocalBetterAuth(t, betterAuthModules)
    await t.mutation(api.seed.indiana, {})

    // 1. New user
    const carol = await makeBetterAuthUser(t, "carol@c.example", "Carol")

    // 2. Create the first org via the same path the React client uses
    //    (helper inserts org + member rows and fires provisioning).
    await createOrganizationAsUser(t, carol.userId, carol.sessionId, {
      slug: "agency-c",
      name: "Agency C LLC",
    })

    // 3. requireTenant resolves and Carol is owner
    const me = await carol.asUser.query(api.tenants.current, {})
    expect(me.role).toBe("owner")
    expect(me.legalName).toBe("Agency C LLC")
    expect(me.canViewNpi).toBe(true)
    expect(me.betterAuthOrgId).toBeTruthy()

    // 4. End-to-end: file create works under the new tenant
    const counties = await t.run((ctx) => ctx.db.query("counties").take(200))
    const marion = counties.find((c) => c.fipsCode === "18097")!
    const file = await carol.asUser.mutation(api.files.create, {
      fileNumber: "C-0001",
      countyId: marion._id,
      transactionType: "purchase",
    })
    expect(file.fileId).toBeTruthy()

    // 5. Audit trail wired correctly
    const events = await carol.asUser.query(api.audit.listForTenant, {})
    const actions = events.map((e: { action: string }) => e.action)
    expect(actions).toEqual(
      expect.arrayContaining([
        "tenant.created",
        "member.added",
        "file.created",
      ]),
    )
  })
})
