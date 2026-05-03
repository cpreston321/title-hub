/**
 * "My queue" — one query that aggregates everything the current member
 * should be looking at. Drives the /queue landing page so an employee
 * isn't fishing across files / mail / followups every morning.
 *
 * Buckets, in priority order:
 *   1. Overdue follow-ups they own
 *   2. Findings assigned to them with status open/acknowledged
 *   3. Inbound emails assigned to them, still in triage states
 *   4. Upcoming follow-ups (next 48h)
 *   5. Unmentioned blockers — open `block` findings on any file with no
 *      assignee yet (so the team sees what's homeless)
 *   6. Quarantined emails with no assignee yet (same — needs an owner)
 *
 * Each bucket is bounded; a noisy tenant can't blow the query budget.
 */
import { v } from 'convex/values'
import { query } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import { optionalTenant } from './lib/tenant'

const FOLLOWUP_LOOKAHEAD_MS = 48 * 60 * 60_000
const PER_BUCKET = 25

export const list = query({
  args: {},
  handler: async (ctx) => {
    const tc = await optionalTenant(ctx)
    if (!tc) {
      return {
        overdueFollowups: [],
        myFindings: [],
        myEmails: [],
        upcomingFollowups: [],
        unownedBlockers: [],
        unownedTriage: [],
      }
    }

    const now = Date.now()

    const fileById = new Map<Id<'files'>, Doc<'files'>>()
    const memberById = new Map<Id<'tenantMembers'>, Doc<'tenantMembers'>>()
    const loadFile = async (id: Id<'files'>) => {
      const cached = fileById.get(id)
      if (cached) return cached
      const f = await ctx.db.get(id)
      if (f) fileById.set(id, f)
      return f
    }
    const loadMember = async (id: Id<'tenantMembers'>) => {
      const cached = memberById.get(id)
      if (cached) return cached
      const m = await ctx.db.get(id)
      if (m) memberById.set(id, m)
      return m
    }

    // 1 + 4: my followups, split by overdue vs upcoming
    const myFollowupsRaw = await ctx.db
      .query('fileFollowups')
      .withIndex('by_tenant_member_due', (q) =>
        q.eq('tenantId', tc.tenantId).eq('memberId', tc.memberId)
      )
      .order('asc')
      .take(50)
    const overdueFollowups: Array<{
      _id: Id<'fileFollowups'>
      fileId: Id<'files'>
      fileNumber: string | null
      note: string
      dueAt: number
    }> = []
    const upcomingFollowups: typeof overdueFollowups = []
    for (const r of myFollowupsRaw) {
      if (r.completedAt) continue
      const file = await loadFile(r.fileId)
      const item = {
        _id: r._id,
        fileId: r.fileId,
        fileNumber: file?.fileNumber ?? null,
        note: r.note,
        dueAt: r.dueAt,
      }
      if (r.dueAt <= now) overdueFollowups.push(item)
      else if (r.dueAt - now <= FOLLOWUP_LOOKAHEAD_MS)
        upcomingFollowups.push(item)
    }

    // 2: findings assigned to me (open or acknowledged)
    const myAssigned = await ctx.db
      .query('reconciliationFindings')
      .withIndex('by_tenant_assignee_status', (q) =>
        q.eq('tenantId', tc.tenantId).eq('assigneeMemberId', tc.memberId)
      )
      .order('desc')
      .take(PER_BUCKET * 4)
    const myFindings: Array<{
      _id: Id<'reconciliationFindings'>
      fileId: Id<'files'>
      fileNumber: string | null
      severity: 'info' | 'warn' | 'block'
      findingType: string
      message: string
      status: 'open' | 'acknowledged'
    }> = []
    for (const f of myAssigned) {
      if (f.status !== 'open' && f.status !== 'acknowledged') continue
      const file = await loadFile(f.fileId)
      myFindings.push({
        _id: f._id,
        fileId: f.fileId,
        fileNumber: file?.fileNumber ?? null,
        severity: f.severity,
        findingType: f.findingType,
        message: f.message,
        status: f.status,
      })
      if (myFindings.length >= PER_BUCKET) break
    }
    myFindings.sort((a, b) => sevWeight(b.severity) - sevWeight(a.severity))

    // 3: emails assigned to me (still in triage / classifying / failed)
    const myEmailsRaw = await ctx.db
      .query('inboundEmails')
      .withIndex('by_tenant_assignee_status', (q) =>
        q.eq('tenantId', tc.tenantId).eq('assigneeMemberId', tc.memberId)
      )
      .order('desc')
      .take(PER_BUCKET * 3)
    const myEmails: Array<{
      _id: Id<'inboundEmails'>
      subject: string
      fromAddress: string
      receivedAt: number
      status: string
      classificationIntent: string | null
      matchedFileId: Id<'files'> | null
    }> = []
    for (const e of myEmailsRaw) {
      if (
        e.status !== 'quarantined' &&
        e.status !== 'pending' &&
        e.status !== 'classifying' &&
        e.status !== 'failed'
      ) {
        continue
      }
      myEmails.push({
        _id: e._id,
        subject: e.subject,
        fromAddress: e.fromAddress,
        receivedAt: e.receivedAt,
        status: e.status,
        classificationIntent: e.classification?.intent ?? null,
        matchedFileId: e.matchedFileId ?? null,
      })
      if (myEmails.length >= PER_BUCKET) break
    }

    // 5: blockers nobody owns. by_tenant_status puts open findings together;
    // walk a bounded slice and filter by severity + missing assignee.
    const openFindings = await ctx.db
      .query('reconciliationFindings')
      .withIndex('by_tenant_status', (q) =>
        q.eq('tenantId', tc.tenantId).eq('status', 'open')
      )
      .order('desc')
      .take(200)
    const unownedBlockers: Array<{
      _id: Id<'reconciliationFindings'>
      fileId: Id<'files'>
      fileNumber: string | null
      findingType: string
      message: string
      createdAt: number
    }> = []
    for (const f of openFindings) {
      if (f.severity !== 'block') continue
      if (f.assigneeMemberId) continue
      const file = await loadFile(f.fileId)
      unownedBlockers.push({
        _id: f._id,
        fileId: f.fileId,
        fileNumber: file?.fileNumber ?? null,
        findingType: f.findingType,
        message: f.message,
        createdAt: f.createdAt,
      })
      if (unownedBlockers.length >= PER_BUCKET) break
    }

    // 6: triage emails nobody owns
    const triageRaw = await ctx.db
      .query('inboundEmails')
      .withIndex('by_tenant_status_received', (q) =>
        q.eq('tenantId', tc.tenantId).eq('status', 'quarantined')
      )
      .order('desc')
      .take(PER_BUCKET * 3)
    const unownedTriage: Array<{
      _id: Id<'inboundEmails'>
      subject: string
      fromAddress: string
      receivedAt: number
      classificationIntent: string | null
      spamTier: string | null
    }> = []
    for (const e of triageRaw) {
      if (e.assigneeMemberId) continue
      unownedTriage.push({
        _id: e._id,
        subject: e.subject,
        fromAddress: e.fromAddress,
        receivedAt: e.receivedAt,
        classificationIntent: e.classification?.intent ?? null,
        spamTier: e.spamTier ?? null,
      })
      if (unownedTriage.length >= PER_BUCKET) break
    }

    void loadMember
    return {
      overdueFollowups: overdueFollowups.slice(0, PER_BUCKET),
      myFindings,
      myEmails,
      upcomingFollowups: upcomingFollowups.slice(0, PER_BUCKET),
      unownedBlockers,
      unownedTriage,
    }
  },
})

function sevWeight(s: string): number {
  return s === 'block' ? 3 : s === 'warn' ? 2 : 1
}

// Lightweight summary for the sidebar / header — total items in queue plus
// the at-risk count (overdue + unowned-blocker).
export const summary = query({
  args: {},
  handler: async (ctx) => {
    const tc = await optionalTenant(ctx)
    if (!tc) return { total: 0, atRisk: 0 }
    void v
    let atRisk = 0
    let total = 0

    const myFollowups = await ctx.db
      .query('fileFollowups')
      .withIndex('by_tenant_member_due', (q) =>
        q.eq('tenantId', tc.tenantId).eq('memberId', tc.memberId)
      )
      .take(50)
    const now = Date.now()
    for (const f of myFollowups) {
      if (f.completedAt) continue
      total++
      if (f.dueAt <= now) atRisk++
    }

    const assignedFindings = await ctx.db
      .query('reconciliationFindings')
      .withIndex('by_tenant_assignee_status', (q) =>
        q.eq('tenantId', tc.tenantId).eq('assigneeMemberId', tc.memberId)
      )
      .take(50)
    for (const f of assignedFindings) {
      if (f.status !== 'open' && f.status !== 'acknowledged') continue
      total++
      if (f.severity === 'block') atRisk++
    }

    const assignedEmails = await ctx.db
      .query('inboundEmails')
      .withIndex('by_tenant_assignee_status', (q) =>
        q.eq('tenantId', tc.tenantId).eq('assigneeMemberId', tc.memberId)
      )
      .take(50)
    for (const e of assignedEmails) {
      if (e.status === 'archived' || e.status === 'spam') continue
      if (e.status === 'auto_attached') continue
      total++
    }

    return { total, atRisk }
  },
})
