import { betterAuth } from "better-auth/minimal"
import { magicLink } from "better-auth/plugins/magic-link"
import { createClient, type GenericCtx } from "@convex-dev/better-auth"
import { convex } from "@convex-dev/better-auth/plugins"
import authConfig from "./auth.config"
import { components, internal } from "./_generated/api"
import { query } from "./_generated/server"
import type { DataModel } from "./_generated/dataModel"
import {
  magicLinkEmail,
  passwordResetEmail,
  verificationEmail,
} from "./email"

const siteUrl = process.env.SITE_URL!

export const authComponent = createClient<DataModel>(components.betterAuth)

const env = (key: string) => {
  const v = process.env[key]
  return v && v.length > 0 ? v : undefined
}

function socialProviders() {
  const out: Record<string, { clientId: string; clientSecret: string }> = {}

  const googleId = env("GOOGLE_CLIENT_ID")
  const googleSecret = env("GOOGLE_CLIENT_SECRET")
  if (googleId && googleSecret) {
    out.google = { clientId: googleId, clientSecret: googleSecret }
  }

  const msId = env("MICROSOFT_CLIENT_ID")
  const msSecret = env("MICROSOFT_CLIENT_SECRET")
  if (msId && msSecret) {
    out.microsoft = { clientId: msId, clientSecret: msSecret }
  }

  return out
}

type EmailArgs = { to: string; subject: string; html: string; text?: string }

function scheduleEmail(ctx: GenericCtx<DataModel>, args: EmailArgs) {
  const maybeScheduler = (ctx as { scheduler?: { runAfter: Function } })
    .scheduler
  if (!maybeScheduler) {
    console.warn("[auth] cannot send email from query context")
    return
  }
  return (maybeScheduler.runAfter as (
    ms: number,
    ref: typeof internal.email.send,
    args: EmailArgs,
  ) => Promise<unknown>)(0, internal.email.send, args)
}

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth({
    baseURL: siteUrl,
    database: authComponent.adapter(ctx),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
        await scheduleEmail(ctx, {
          to: user.email,
          ...passwordResetEmail(url),
        })
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({
        user,
        url,
      }: {
        user: { email: string }
        url: string
      }) => {
        await scheduleEmail(ctx, {
          to: user.email,
          ...verificationEmail(url),
        })
      },
    },
    socialProviders: socialProviders(),
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          await scheduleEmail(ctx, {
            to: email,
            ...magicLinkEmail(url),
          })
        },
      }),
      convex({ authConfig }),
    ],
  })
}

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    return await authComponent.getAuthUser(ctx)
  },
})
