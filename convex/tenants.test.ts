/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import betterAuthTest from "@convex-dev/better-auth/test"
import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import schema from "./schema"
import { makeBetterAuthUser } from "./lib/test-helpers"

const modules = import.meta.glob("./**/*.ts")

describe("tenant isolation", () => {
  test("a user can create a tenant and become its owner", async () => {
    const t = convexTest(schema, modules)
    betterAuthTest.register(t)
    const alice = await makeBetterAuthUser(t, "alice@a.example", "Alice")

    const created = await alice.asUser.mutation(api.tenants.create, {
      slug: "agency-a",
      legalName: "Agency A LLC",
    })
    expect(created.tenantId).toBeTruthy()

    const current = await alice.asUser.query(api.tenants.current, {})
    expect(current.role).toBe("owner")
    expect(current.legalName).toBe("Agency A LLC")
    expect(current.canViewNpi).toBe(true)
  })

  test("a user cannot setActive on a tenant they do not belong to", async () => {
    const t = convexTest(schema, modules)
    betterAuthTest.register(t)

    const alice = await makeBetterAuthUser(t, "alice@a.example", "Alice")
    const bob = await makeBetterAuthUser(t, "bob@b.example", "Bob")

    const aliceTenant = await alice.asUser.mutation(api.tenants.create, {
      slug: "agency-a",
      legalName: "Agency A LLC",
    })
    await bob.asUser.mutation(api.tenants.create, {
      slug: "agency-b",
      legalName: "Agency B LLC",
    })

    await expect(
      bob.asUser.mutation(api.tenants.setActive, {
        tenantId: aliceTenant.tenantId,
      }),
    ).rejects.toThrow(/NOT_A_MEMBER/)
  })

  test("requireTenant in tenants.current returns the active tenant only", async () => {
    const t = convexTest(schema, modules)
    betterAuthTest.register(t)

    const alice = await makeBetterAuthUser(t, "alice@a.example", "Alice")
    const bob = await makeBetterAuthUser(t, "bob@b.example", "Bob")

    await alice.asUser.mutation(api.tenants.create, {
      slug: "agency-a",
      legalName: "Agency A LLC",
    })
    const bobTenant = await bob.asUser.mutation(api.tenants.create, {
      slug: "agency-b",
      legalName: "Agency B LLC",
    })

    const aliceCurrent = await alice.asUser.query(api.tenants.current, {})
    expect(aliceCurrent.slug).toBe("agency-a")

    const bobCurrent = await bob.asUser.query(api.tenants.current, {})
    expect(bobCurrent.slug).toBe("agency-b")
    expect(bobCurrent.tenantId).toBe(bobTenant.tenantId)
  })

  test("an unauthenticated caller is rejected by tenants.current", async () => {
    const t = convexTest(schema, modules)
    betterAuthTest.register(t)
    await expect(t.query(api.tenants.current, {})).rejects.toThrow()
  })

  test("a member with no active tenant gets NO_ACTIVE_TENANT", async () => {
    const t = convexTest(schema, modules)
    betterAuthTest.register(t)

    const alice = await makeBetterAuthUser(t, "alice@a.example", "Alice")
    await expect(
      alice.asUser.query(api.tenants.current, {}),
    ).rejects.toThrow(/NO_ACTIVE_TENANT/)
  })
})
