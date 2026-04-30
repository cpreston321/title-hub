"use node"

import { v } from "convex/values"
import { Resend } from "resend"
import { internalAction } from "./_generated/server"

const FROM =
  process.env.RESEND_FROM_EMAIL ?? "Title Ops <noreply@example.com>"

let cached: Resend | null = null
function client(): Resend | null {
  if (cached) return cached
  const key = process.env.RESEND_API_KEY
  if (!key) return null
  cached = new Resend(key)
  return cached
}

export const send = internalAction({
  args: {
    to: v.string(),
    subject: v.string(),
    html: v.string(),
    text: v.optional(v.string()),
  },
  handler: async (_ctx, { to, subject, html, text }) => {
    const resend = client()
    if (!resend) {
      // No-op fallback so local dev / tests don't require RESEND_API_KEY.
      console.warn(
        `[email] RESEND_API_KEY not set; would have sent to=${to} subject=${subject}`,
      )
      return { ok: false, reason: "RESEND_API_KEY_MISSING" as const }
    }
    const { data, error } = await resend.emails.send({
      from: FROM,
      to,
      subject,
      html,
      text,
    })
    if (error) {
      console.error("[email] resend send failed", error)
      throw new Error(error.message ?? "RESEND_SEND_FAILED")
    }
    return { ok: true, id: data?.id ?? null }
  },
})

export function verificationEmail(url: string) {
  return {
    subject: "Verify your email",
    html: `<p>Click to verify your email address:</p><p><a href="${url}">Verify email</a></p>`,
    text: `Verify your email: ${url}`,
  }
}

export function passwordResetEmail(url: string) {
  return {
    subject: "Reset your password",
    html: `<p>Click to reset your password:</p><p><a href="${url}">Reset password</a></p>`,
    text: `Reset your password: ${url}`,
  }
}

export function magicLinkEmail(url: string) {
  return {
    subject: "Your sign-in link",
    html: `<p>Click to sign in:</p><p><a href="${url}">Sign in</a></p>`,
    text: `Sign in: ${url}`,
  }
}
