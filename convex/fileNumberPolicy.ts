import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireRole, requireTenant } from './lib/tenant'
import { recordAudit } from './lib/audit'
import {
  DEFAULT_PATTERN,
  TOKENS,
  boundaryFor,
  formatFileNumber,
  validatePattern,
  type Cadence,
} from './lib/fileNumber'

// Wire-shape helpers ─ keep return types stable so the UI doesn't need to
// reason about whether the row exists.

export const get = query({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)
    const row = await ctx.db
      .query('tenantFileNumberPolicy')
      .withIndex('by_tenant', (q) => q.eq('tenantId', tc.tenantId))
      .unique()
    return {
      pattern: row?.pattern ?? DEFAULT_PATTERN,
      nextSeq: row?.nextSeq ?? 1,
      seqResetCadence: (row?.seqResetCadence ?? 'yearly') as Cadence,
      seqLastResetBoundary: row?.seqLastResetBoundary ?? '',
      isCustomized: !!row,
      defaultPattern: DEFAULT_PATTERN,
      // Decorate tokens with their example so the UI can render chips
      // without re-implementing token catalogue.
      tokens: TOKENS.map((t) => ({
        name: t.name,
        label: t.label,
        example: t.example,
        parameterized: !!t.parameterized,
      })),
      updatedAt: row?.updatedAt ?? null,
    }
  },
})

/**
 * Render the next N file numbers given the policy + an optional sample
 * context (county, txn). When `pattern` / `nextSeq` / `seqResetCadence`
 * overrides are passed, the renderer uses them instead of the saved row —
 * lets the admin editor preview a draft pattern against real tenant data.
 * No state is changed.
 */
export const previewBatch = query({
  args: {
    count: v.optional(v.number()),
    countyId: v.optional(v.id('counties')),
    transactionType: v.optional(v.string()),
    // Draft overrides — use these instead of the saved row when present.
    pattern: v.optional(v.string()),
    nextSeq: v.optional(v.number()),
    seqResetCadence: v.optional(
      v.union(v.literal('never'), v.literal('yearly'), v.literal('monthly'))
    ),
  },
  handler: async (
    ctx,
    { count, countyId, transactionType, pattern, nextSeq, seqResetCadence }
  ) => {
    const tc = await requireTenant(ctx)
    const row = await ctx.db
      .query('tenantFileNumberPolicy')
      .withIndex('by_tenant', (q) => q.eq('tenantId', tc.tenantId))
      .unique()

    const effectivePattern = pattern ?? row?.pattern ?? DEFAULT_PATTERN
    const cadence = (seqResetCadence ??
      row?.seqResetCadence ??
      'yearly') as Cadence
    // When the cadence is the SAVED cadence, anchor against the saved
    // boundary so a year change correctly resets. With a draft cadence we
    // can't do that — just assume "no reset pending" for the preview.
    const lastBoundary =
      seqResetCadence && seqResetCadence !== row?.seqResetCadence
        ? boundaryFor(new Date(), cadence)
        : row?.seqLastResetBoundary ?? ''
    const seq = nextSeq ?? row?.nextSeq ?? 1

    // Validate draft patterns; when invalid, return empty previews so the
    // UI can show a clean error state instead of garbage strings.
    const issues = pattern ? validatePattern(pattern) : []
    if (issues.length > 0) {
      return {
        pattern: effectivePattern,
        previews: [],
        effectiveStartSeq: seq,
        cadenceWillReset: false,
        currentBoundary: '',
        invalid: true,
        issues: issues.map((i) => i.message),
      }
    }

    const date = new Date()
    const currentBoundary = boundaryFor(date, cadence)
    const startSeq = currentBoundary !== lastBoundary ? 1 : seq

    let countyCode: string | null = null
    let stateCode: string | null = null
    if (countyId) {
      // Counties are platform-shared (no tenantId column); reading without
      // a tenant filter is intentional. The COUNTY token wants a compact
      // identifier — strip whitespace from the name.
      const county = await ctx.db.get(countyId)
      if (county) {
        countyCode = county.name.replace(/\s+/g, '').toUpperCase()
        stateCode = county.stateCode
      }
    }
    const n = Math.min(Math.max(count ?? 3, 1), 10)
    const out: string[] = []
    for (let i = 0; i < n; i++) {
      out.push(
        formatFileNumber(effectivePattern, {
          seq: startSeq + i,
          date,
          countyCode,
          stateCode,
          transactionType: transactionType ?? null,
        })
      )
    }
    return {
      pattern: effectivePattern,
      previews: out,
      effectiveStartSeq: startSeq,
      cadenceWillReset: currentBoundary !== lastBoundary,
      currentBoundary,
      invalid: false,
      issues: [] as ReadonlyArray<string>,
    }
  },
})

const cadenceV = v.union(
  v.literal('never'),
  v.literal('yearly'),
  v.literal('monthly')
)

export const set = mutation({
  args: {
    pattern: v.string(),
    nextSeq: v.number(),
    seqResetCadence: cadenceV,
  },
  handler: async (ctx, args) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner')

    const issues = validatePattern(args.pattern)
    if (issues.length > 0) {
      throw new ConvexError({
        kind: 'INVALID_PATTERN',
        issues: issues.map((i) => i.message),
      })
    }
    if (!Number.isInteger(args.nextSeq) || args.nextSeq < 1) {
      throw new ConvexError({
        kind: 'INVALID_NEXT_SEQ',
        message: 'Counter must be a positive integer.',
      })
    }

    const existing = await ctx.db
      .query('tenantFileNumberPolicy')
      .withIndex('by_tenant', (q) => q.eq('tenantId', tc.tenantId))
      .unique()
    const now = Date.now()
    const boundary = boundaryFor(new Date(now), args.seqResetCadence)
    if (existing) {
      await ctx.db.patch(existing._id, {
        pattern: args.pattern,
        nextSeq: args.nextSeq,
        seqResetCadence: args.seqResetCadence,
        // Anchor the boundary at the current window so we don't reset on
        // the very next save just because cadence changed.
        seqLastResetBoundary: boundary,
        updatedAt: now,
        updatedByMemberId: tc.memberId,
      })
    } else {
      await ctx.db.insert('tenantFileNumberPolicy', {
        tenantId: tc.tenantId,
        pattern: args.pattern,
        nextSeq: args.nextSeq,
        seqResetCadence: args.seqResetCadence,
        seqLastResetBoundary: boundary,
        updatedAt: now,
        updatedByMemberId: tc.memberId,
      })
    }
    await recordAudit(ctx, tc, 'fileNumberPolicy.set', 'tenant', tc.tenantId, {
      pattern: args.pattern,
      nextSeq: args.nextSeq,
      seqResetCadence: args.seqResetCadence,
    })
    return { ok: true as const }
  },
})

/**
 * Drop the policy row entirely. files.create reverts to its legacy
 * "manual fileNumber required" behaviour for this tenant.
 */
export const reset = mutation({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner')
    const existing = await ctx.db
      .query('tenantFileNumberPolicy')
      .withIndex('by_tenant', (q) => q.eq('tenantId', tc.tenantId))
      .unique()
    if (existing) {
      await ctx.db.delete(existing._id)
      await recordAudit(
        ctx,
        tc,
        'fileNumberPolicy.reset',
        'tenant',
        tc.tenantId,
        {}
      )
    }
    return { ok: true as const }
  },
})
