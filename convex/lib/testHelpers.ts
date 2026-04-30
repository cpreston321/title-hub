import type { TestConvex } from "convex-test"
import type { GenericSchema, SchemaDefinition } from "convex/server"
import { components, internal } from "../_generated/api"
import betterAuthSchema from "../betterAuth/schema"

type T = TestConvex<SchemaDefinition<GenericSchema, boolean>>

// Pass the result of `import.meta.glob("../betterAuth/**/*.ts")` from the test
// file. Doing the glob here would force Convex's module loader to evaluate
// import.meta.glob, which it does not support.
export function registerLocalBetterAuth(
  t: T,
  modules: Record<string, () => Promise<unknown>>,
) {
  t.registerComponent("betterAuth", betterAuthSchema, modules)
}

export async function makeBetterAuthUser(t: T, email: string, name: string) {
  const now = Date.now()
  const user = (await t.run(async (ctx) =>
    ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name,
          email,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      },
    }),
  )) as { _id: string }

  const session = (await t.run(async (ctx) =>
    ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "session",
        data: {
          token: `tok_${user._id}`,
          userId: user._id,
          expiresAt: now + 24 * 60 * 60 * 1000,
          createdAt: now,
          updatedAt: now,
        },
      },
    }),
  )) as { _id: string }

  const asUser = t.withIdentity({
    subject: user._id,
    ...({ sessionId: session._id } as object),
  })

  return { userId: user._id, sessionId: session._id, asUser }
}

/**
 * Helper that mirrors what `authClient.organization.create` would do via
 * Better Auth: insert an organization row, insert an owner member row, set
 * the user's session activeOrganizationId. The adapter.create calls fire the
 * configured `authFunctions.onCreate` trigger which provisions our app-side
 * tenants + tenantMembers rows.
 */
export async function createOrganizationAsUser(
  t: T,
  userId: string,
  sessionId: string,
  args: { slug: string; name: string },
): Promise<{ orgId: string }> {
  const now = Date.now()

  const org = (await t.run(async (ctx) =>
    ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "organization",
        data: {
          name: args.name,
          slug: args.slug,
          createdAt: now,
        },
      },
    }),
  )) as { _id: string }

  // Provisioning trigger normally fires via authFunctions.onCreate; the test
  // bypasses convexAdapter so we invoke it directly.
  await t.mutation(internal.tenants.provisionFromBetterAuthOrg, {
    betterAuthOrgId: org._id,
    slug: args.slug,
    legalName: args.name,
  })

  await t.run(async (ctx) =>
    ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "member",
        data: {
          organizationId: org._id,
          userId,
          role: "owner",
          createdAt: now,
        },
      },
    }),
  )

  await t.mutation(internal.tenants.provisionMemberFromBetterAuth, {
    betterAuthOrgId: org._id,
    betterAuthUserId: userId,
    betterAuthRole: "owner",
  })

  await t.run(async (ctx) =>
    ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: "session",
        where: [{ field: "_id", value: sessionId }],
        update: { activeOrganizationId: org._id },
      },
    }),
  )

  return { orgId: org._id }
}
