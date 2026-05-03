/**
 * Member-scoped follow-up reminders on a file. "Remind me Tuesday morning to
 * chase the survey on file X." A scheduled internalMutation fires at dueAt
 * and creates a notification — the bell + queue surface it.
 *
 * No cron polling: each followup schedules its own callback at dueAt via
 * `ctx.scheduler.runAt`. Cancelling / rescheduling cancels the prior job
 * by id (best-effort).
 */
import { ConvexError, v } from 'convex/values'
import { internalMutation, mutation, query } from './_generated/server'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { optionalTenant, requireRole, requireTenant } from './lib/tenant'
import { recordAudit } from './lib/audit'

const editorRoles = ['owner', 'admin', 'processor', 'closer', 'reviewer'] as const
const MAX_NOTE = 500

export const schedule = mutation({
  args: {
    fileId: v.id('files'),
    dueAt: v.number(),
    note: v.string(),
    // Defaults to current member if omitted.
    memberId: v.optional(v.id('tenantMembers')),
  },
  handler: async (ctx, { fileId, dueAt, note, memberId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    const file = await ctx.db.get(fileId)
    if (!file || file.tenantId !== tc.tenantId) {
      throw new ConvexError('FILE_NOT_FOUND')
    }
    const trimmed = note.trim()
    if (!trimmed) throw new ConvexError('FOLLOWUP_NOTE_REQUIRED')
    if (trimmed.length > MAX_NOTE) throw new ConvexError('FOLLOWUP_NOTE_TOO_LONG')
    if (dueAt <= Date.now()) throw new ConvexError('FOLLOWUP_DUE_IN_PAST')

    let owner: Id<'tenantMembers'> = tc.memberId
    if (memberId) {
      const m = await ctx.db.get(memberId)
      if (!m || m.tenantId !== tc.tenantId || m.status !== 'active') {
        throw new ConvexError('FOLLOWUP_OWNER_INVALID')
      }
      owner = memberId
    }

    const now = Date.now()
    const id = await ctx.db.insert('fileFollowups', {
      tenantId: tc.tenantId,
      fileId,
      memberId: owner,
      note: trimmed,
      dueAt,
      createdByMemberId: tc.memberId,
      createdAt: now,
    })

    await ctx.scheduler.runAt(dueAt, internal.followups._fire, {
      followupId: id,
    })

    await recordAudit(ctx, tc, 'followup.scheduled', 'file', fileId, {
      followupId: id,
      ownerMemberId: owner,
      dueAt,
    })

    return { ok: true, followupId: id }
  },
})

export const complete = mutation({
  args: { followupId: v.id('fileFollowups') },
  handler: async (ctx, { followupId }) => {
    const tc = await requireTenant(ctx)
    const row = await ctx.db.get(followupId)
    if (!row || row.tenantId !== tc.tenantId) {
      throw new ConvexError('FOLLOWUP_NOT_FOUND')
    }
    if (row.completedAt) return { ok: true, alreadyCompleted: true }
    await ctx.db.patch(followupId, {
      completedAt: Date.now(),
      completedByMemberId: tc.memberId,
    })
    await recordAudit(ctx, tc, 'followup.completed', 'file', row.fileId, {
      followupId,
    })
    return { ok: true, alreadyCompleted: false }
  },
})

// Cancel a still-pending follow-up. The owner or whoever scheduled it can
// cancel; admins/owners can always cancel.
export const cancel = mutation({
  args: { followupId: v.id('fileFollowups') },
  handler: async (ctx, { followupId }) => {
    const tc = await requireTenant(ctx)
    const row = await ctx.db.get(followupId)
    if (!row || row.tenantId !== tc.tenantId) {
      throw new ConvexError('FOLLOWUP_NOT_FOUND')
    }
    const canForce = tc.role === 'owner' || tc.role === 'admin'
    if (
      row.memberId !== tc.memberId &&
      row.createdByMemberId !== tc.memberId &&
      !canForce
    ) {
      throw new ConvexError('FOLLOWUP_NOT_YOURS')
    }
    await ctx.db.delete(followupId)
    await recordAudit(ctx, tc, 'followup.cancelled', 'file', row.fileId, {
      followupId,
    })
    return { ok: true }
  },
})

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const tc = await optionalTenant(ctx)
    if (!tc) return []
    const rows = await ctx.db
      .query('fileFollowups')
      .withIndex('by_tenant_member_due', (q) =>
        q.eq('tenantId', tc.tenantId).eq('memberId', tc.memberId)
      )
      .order('asc')
      .take(50)
    const out = []
    for (const r of rows) {
      if (r.completedAt) continue
      const file = await ctx.db.get(r.fileId)
      out.push({
        _id: r._id,
        fileId: r.fileId,
        fileNumber: file?.fileNumber ?? null,
        note: r.note,
        dueAt: r.dueAt,
        overdue: r.dueAt <= Date.now(),
        notifiedAt: r.notifiedAt ?? null,
      })
    }
    return out
  },
})

export const listForFile = query({
  args: { fileId: v.id('files') },
  handler: async (ctx, { fileId }) => {
    const tc = await optionalTenant(ctx)
    if (!tc) return []
    const rows = await ctx.db
      .query('fileFollowups')
      .withIndex('by_tenant_file', (q) =>
        q.eq('tenantId', tc.tenantId).eq('fileId', fileId)
      )
      .order('desc')
      .take(50)
    return await Promise.all(
      rows.map(async (r) => {
        const member = await ctx.db.get(r.memberId)
        return {
          _id: r._id,
          memberId: r.memberId,
          memberEmail: member?.email ?? null,
          note: r.note,
          dueAt: r.dueAt,
          completedAt: r.completedAt ?? null,
          isMine: r.memberId === tc.memberId,
        }
      })
    )
  },
})

// Internal: fired by ctx.scheduler.runAt at dueAt. Idempotent — re-running
// after `completedAt` was set is a no-op.
export const _fire = internalMutation({
  args: { followupId: v.id('fileFollowups') },
  handler: async (ctx, { followupId }) => {
    const row = await ctx.db.get(followupId)
    if (!row) return
    if (row.completedAt) return
    if (row.notifiedAt) return // already fired

    const file = await ctx.db.get(row.fileId)
    const member = await ctx.db.get(row.memberId)
    if (!file || !member) return

    await ctx.db.patch(followupId, { notifiedAt: Date.now() })

    // Followups are member-scoped — only the owner gets the bell row, not
    // the whole tenant. Insert a single notification rather than going
    // through fanOutNotification (which iterates all members).
    await ctx.db.insert('notifications', {
      tenantId: row.tenantId,
      memberId: row.memberId,
      kind: 'followup.due',
      title: `Follow up on ${file.fileNumber}`,
      body: row.note,
      severity: 'info',
      fileId: row.fileId,
      groupKey: `followup.due:${row.fileId}`,
      actorType: 'system',
      occurredAt: Date.now(),
    })
  },
})
