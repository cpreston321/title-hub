/// <reference types="vite/client" />
import type { TestConvex } from "convex-test"
import type { GenericSchema, SchemaDefinition } from "convex/server"
import { components } from "../_generated/api"

type T = TestConvex<SchemaDefinition<GenericSchema, boolean>>

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
