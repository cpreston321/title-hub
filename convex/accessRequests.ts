import { ConvexError, v } from 'convex/values'
import {
  internalAction,
  internalQuery,
  mutation,
} from './_generated/server'
import { internal } from './_generated/api'

// Public-facing endpoint: prospects on the marketing page submit a request
// for access to the pilot. Tenant-less by design — the requester does not
// yet have an account. Reviewed by ops; invitations are sent manually.

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function clean(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined
  const t = s.trim().slice(0, max)
  return t.length > 0 ? t : undefined
}

export const submit = mutation({
  args: {
    email: v.string(),
    contactName: v.string(),
    firmName: v.string(),
    role: v.optional(v.string()),
    region: v.optional(v.string()),
    monthlyVolume: v.optional(v.string()),
    note: v.optional(v.string()),
    // Honeypot — humans never see/fill this. Bots do. We accept the call
    // (no error) but skip the insert.
    company: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.company && args.company.trim().length > 0) {
      // Bot. Pretend success without persisting anything.
      return { ok: true as const, deduped: false as const }
    }

    const email = args.email.trim().toLowerCase()
    if (!EMAIL_RX.test(email) || email.length > 200) {
      throw new ConvexError('Please enter a valid work email address.')
    }
    const contactName = args.contactName.trim().slice(0, 120)
    if (contactName.length < 2) {
      throw new ConvexError('Please add your name.')
    }
    const firmName = args.firmName.trim().slice(0, 160)
    if (firmName.length < 2) {
      throw new ConvexError("Please add your firm's name.")
    }

    // De-duplicate: if the same email submitted within the last hour, treat
    // it as a no-op success. Avoids accidental double-posts and trivial
    // spam.
    const since = Date.now() - 60 * 60 * 1000
    const recent = await ctx.db
      .query('accessRequests')
      .withIndex('by_email_time', (q) =>
        q.eq('email', email).gte('submittedAt', since),
      )
      .first()
    if (recent) {
      return { ok: true as const, deduped: true as const }
    }

    const id = await ctx.db.insert('accessRequests', {
      email,
      contactName,
      firmName,
      role: clean(args.role, 80),
      region: clean(args.region, 120),
      monthlyVolume: clean(args.monthlyVolume, 40),
      note: clean(args.note, 1000),
      source: 'marketing',
      status: 'new',
      submittedAt: Date.now(),
    })

    // Fire-and-forget notification to ops. The action no-ops if Resend isn't
    // configured, so local dev / tests don't require an API key.
    await ctx.scheduler.runAfter(
      0,
      internal.accessRequests.notifyOps,
      { requestId: id },
    )

    return { ok: true as const, deduped: false as const }
  },
})

// Read a single request inside an internal action so the action doesn't need
// db access directly. (Actions have no transactional guarantees against the
// rest of a mutation, so we read after the insert is committed.)
export const _get = internalQuery({
  args: { requestId: v.id('accessRequests') },
  handler: async (ctx, { requestId }) => {
    return await ctx.db.get(requestId)
  },
})

export const notifyOps = internalAction({
  args: { requestId: v.id('accessRequests') },
  handler: async (ctx, { requestId }) => {
    const to = process.env.ACCESS_REQUEST_NOTIFY_TO
    if (!to) {
      // Nothing to do — local dev and tests run without a notify address.
      return { ok: false as const, reason: 'NOTIFY_TO_MISSING' as const }
    }
    const row = await ctx.runQuery(internal.accessRequests._get, {
      requestId,
    })
    if (!row) return { ok: false as const, reason: 'NOT_FOUND' as const }

    const subject = `Access request — ${row.firmName}`
    const lines = [
      `Firm: ${row.firmName}`,
      `Contact: ${row.contactName} <${row.email}>`,
      row.role ? `Role: ${row.role}` : null,
      row.region ? `Region: ${row.region}` : null,
      row.monthlyVolume ? `Monthly volume: ${row.monthlyVolume}` : null,
      row.note ? `\nNote:\n${row.note}` : null,
      `\nSubmitted: ${new Date(row.submittedAt).toUTCString()}`,
    ].filter(Boolean) as ReadonlyArray<string>
    const text = lines.join('\n')
    const html = `<pre style="font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`

    await ctx.runAction(internal.email.send, {
      to,
      subject,
      html,
      text,
    })
    return { ok: true as const }
  },
})

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
