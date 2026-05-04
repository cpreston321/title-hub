import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireRole, requireTenant } from './lib/tenant'
import { recordAudit } from './lib/audit'
import {
  DEFAULT_TOLERANCES,
  FINDING_CATALOG,
  REQUIRED_DOC_CATALOG,
  TOLERANCE_BOUNDS,
  getCatalogEntry,
  getDocCatalogEntry,
  loadTolerances,
  type Tolerances,
} from './lib/reconciliationPolicy'

const policySeverityV = v.union(
  v.literal('info'),
  v.literal('warn'),
  v.literal('block'),
  v.literal('off')
)

/**
 * List the full reconciliation finding catalog joined with the active
 * tenant's per-finding overrides. The admin page renders this directly.
 */
export const listForTenant = query({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)
    const overrides = await ctx.db
      .query('tenantReconciliationPolicies')
      .withIndex('by_tenant', (q) => q.eq('tenantId', tc.tenantId))
      .collect()
    const overrideByType = new Map(
      overrides.map((row) => [row.findingType, row])
    )

    return FINDING_CATALOG.map((entry) => {
      const row = overrideByType.get(entry.type)
      return {
        type: entry.type,
        label: entry.label,
        description: entry.description,
        category: entry.category,
        defaultSeverity: entry.defaultSeverity,
        // `null` here is the wire shape for "no override" — undefined doesn't
        // serialize cleanly through Convex.
        overrideSeverity: row?.severity ?? null,
        updatedAt: row?.updatedAt ?? null,
      }
    })
  },
})

/**
 * Upsert a per-tenant override. Owners only — severity tuning is a policy
 * decision, not a daily operating action.
 */
export const upsert = mutation({
  args: {
    findingType: v.string(),
    severity: policySeverityV,
  },
  handler: async (ctx, { findingType, severity }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner')
    if (!getCatalogEntry(findingType)) {
      throw new ConvexError({ kind: 'UNKNOWN_FINDING_TYPE', findingType })
    }

    const existing = await ctx.db
      .query('tenantReconciliationPolicies')
      .withIndex('by_tenant_finding', (q) =>
        q.eq('tenantId', tc.tenantId).eq('findingType', findingType)
      )
      .unique()

    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, {
        severity,
        updatedAt: now,
        updatedByMemberId: tc.memberId,
      })
    } else {
      await ctx.db.insert('tenantReconciliationPolicies', {
        tenantId: tc.tenantId,
        findingType,
        severity,
        updatedAt: now,
        updatedByMemberId: tc.memberId,
      })
    }

    await recordAudit(
      ctx,
      tc,
      'reconciliationPolicy.upsert',
      'finding_type',
      findingType,
      { severity }
    )
    return { ok: true as const }
  },
})

/**
 * Remove a per-tenant override and fall back to the catalog default.
 */
export const reset = mutation({
  args: {
    findingType: v.string(),
  },
  handler: async (ctx, { findingType }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner')

    const existing = await ctx.db
      .query('tenantReconciliationPolicies')
      .withIndex('by_tenant_finding', (q) =>
        q.eq('tenantId', tc.tenantId).eq('findingType', findingType)
      )
      .unique()

    if (existing) {
      await ctx.db.delete(existing._id)
      await recordAudit(
        ctx,
        tc,
        'reconciliationPolicy.reset',
        'finding_type',
        findingType,
        {}
      )
    }
    return { ok: true as const }
  },
})

/**
 * Wipe every override and restore catalog defaults. Surfaced from the page
 * footer as a "Reset all to defaults" escape hatch.
 */
export const resetAll = mutation({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner')
    const overrides = await ctx.db
      .query('tenantReconciliationPolicies')
      .withIndex('by_tenant', (q) => q.eq('tenantId', tc.tenantId))
      .collect()
    for (const row of overrides) {
      await ctx.db.delete(row._id)
    }
    await recordAudit(
      ctx,
      tc,
      'reconciliationPolicy.resetAll',
      'tenant',
      tc.tenantId,
      { cleared: overrides.length }
    )
    return { ok: true as const, cleared: overrides.length }
  },
})

// ─────────────────────────────────────────────────────────────────────
// Numeric tolerances
// ─────────────────────────────────────────────────────────────────────

/**
 * Read tolerances merged against the catalog defaults, plus the catalog
 * defaults themselves and the input bounds. Owners need all three to render
 * a sensible editor (effective vs. default vs. allowed).
 */
export const getTolerances = query({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)
    const effective = await loadTolerances(ctx, tc.tenantId)
    const row = await ctx.db
      .query('tenantReconciliationTolerances')
      .withIndex('by_tenant', (q) => q.eq('tenantId', tc.tenantId))
      .unique()
    return {
      effective,
      defaults: DEFAULT_TOLERANCES,
      bounds: TOLERANCE_BOUNDS,
      // `null` if the tenant has never customised — the UI hides "reset" then.
      hasOverride: !!row,
      updatedAt: row?.updatedAt ?? null,
    }
  },
})

const toleranceArgs = {
  salePriceVarianceLow: v.number(),
  salePriceVarianceHigh: v.number(),
  wireAmountRedFlagRatio: v.number(),
}

/**
 * Set every tolerance at once. Owners only. The mutation validates each
 * value against TOLERANCE_BOUNDS and rejects out-of-range numbers — keeps
 * the reconciler from emitting nonsense findings.
 */
export const setTolerances = mutation({
  args: toleranceArgs,
  handler: async (ctx, args) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner')
    if (args.salePriceVarianceLow >= args.salePriceVarianceHigh) {
      throw new ConvexError({
        kind: 'INVALID_TOLERANCES',
        message: 'salePriceVarianceLow must be strictly less than High.',
      })
    }
    for (const [key, value] of Object.entries(args)) {
      const bounds = TOLERANCE_BOUNDS[key as keyof Tolerances]
      if (value < bounds.min || value > bounds.max) {
        throw new ConvexError({
          kind: 'INVALID_TOLERANCES',
          message: `${key} out of bounds [${bounds.min}, ${bounds.max}].`,
        })
      }
    }

    const existing = await ctx.db
      .query('tenantReconciliationTolerances')
      .withIndex('by_tenant', (q) => q.eq('tenantId', tc.tenantId))
      .unique()
    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, {
        ...args,
        updatedAt: now,
        updatedByMemberId: tc.memberId,
      })
    } else {
      await ctx.db.insert('tenantReconciliationTolerances', {
        tenantId: tc.tenantId,
        ...args,
        updatedAt: now,
        updatedByMemberId: tc.memberId,
      })
    }
    await recordAudit(
      ctx,
      tc,
      'reconciliationPolicy.setTolerances',
      'tenant',
      tc.tenantId,
      args
    )
    return { ok: true as const }
  },
})

/**
 * Drop the tolerances row entirely; reconciliation falls back to defaults.
 */
export const resetTolerances = mutation({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner')
    const row = await ctx.db
      .query('tenantReconciliationTolerances')
      .withIndex('by_tenant', (q) => q.eq('tenantId', tc.tenantId))
      .unique()
    if (row) {
      await ctx.db.delete(row._id)
      await recordAudit(
        ctx,
        tc,
        'reconciliationPolicy.resetTolerances',
        'tenant',
        tc.tenantId,
        {}
      )
    }
    return { ok: true as const }
  },
})

// ─────────────────────────────────────────────────────────────────────
// Required-document overrides per transaction type
// ─────────────────────────────────────────────────────────────────────

/**
 * For every platform transaction type, return the platform baseline list
 * of required docs and the tenant's override (if any). The UI uses this
 * to render a row per transaction type with toggleable doc chips.
 */
export const listRequiredDocs = query({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)
    const platform = await ctx.db.query('transactionTypes').take(50)
    platform.sort((a, b) => a.name.localeCompare(b.name))
    const overrides = await ctx.db
      .query('tenantTransactionTypeOverrides')
      .withIndex('by_tenant', (q) => q.eq('tenantId', tc.tenantId))
      .collect()
    const overrideByCode = new Map(overrides.map((row) => [row.code, row]))

    return {
      transactionTypes: platform.map((tt) => {
        const ov = overrideByCode.get(tt.code)
        const effective = ov ? ov.requiredDocs : tt.requiredDocs
        return {
          code: tt.code,
          name: tt.name,
          platformDefault: tt.requiredDocs,
          effective,
          isOverride: !!ov,
          updatedAt: ov?.updatedAt ?? null,
        }
      }),
      // Catalog is decorated server-side with labels; smaller wire shape
      // than shipping the descriptions on every row.
      catalog: REQUIRED_DOC_CATALOG.map((entry) => ({
        type: entry.type,
        label: entry.label,
        description: entry.description,
      })),
    }
  },
})

export const setRequiredDocs = mutation({
  args: {
    code: v.string(),
    requiredDocs: v.array(v.string()),
  },
  handler: async (ctx, { code, requiredDocs }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner')
    // Verify the transaction type exists on the platform — owners can't
    // create new types from this surface.
    const tt = await ctx.db
      .query('transactionTypes')
      .withIndex('by_code', (q) => q.eq('code', code))
      .unique()
    if (!tt) {
      throw new ConvexError({ kind: 'UNKNOWN_TRANSACTION_TYPE', code })
    }
    // Reject doc types not in the catalog so the UI and the data agree.
    const dedup = Array.from(new Set(requiredDocs))
    for (const d of dedup) {
      if (!getDocCatalogEntry(d)) {
        throw new ConvexError({ kind: 'UNKNOWN_DOC_TYPE', docType: d })
      }
    }

    const existing = await ctx.db
      .query('tenantTransactionTypeOverrides')
      .withIndex('by_tenant_code', (q) =>
        q.eq('tenantId', tc.tenantId).eq('code', code)
      )
      .unique()

    // If the desired list equals the platform default, prefer to remove
    // the override so the table stays clean (parallel to severity policy).
    const equalsDefault =
      dedup.length === tt.requiredDocs.length &&
      dedup.every((d) => tt.requiredDocs.includes(d))

    const now = Date.now()
    if (equalsDefault) {
      if (existing) {
        await ctx.db.delete(existing._id)
        await recordAudit(
          ctx,
          tc,
          'reconciliationPolicy.resetRequiredDocs',
          'transaction_type',
          code,
          {}
        )
      }
      return { ok: true as const }
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        requiredDocs: dedup,
        updatedAt: now,
        updatedByMemberId: tc.memberId,
      })
    } else {
      await ctx.db.insert('tenantTransactionTypeOverrides', {
        tenantId: tc.tenantId,
        code,
        requiredDocs: dedup,
        updatedAt: now,
        updatedByMemberId: tc.memberId,
      })
    }
    await recordAudit(
      ctx,
      tc,
      'reconciliationPolicy.setRequiredDocs',
      'transaction_type',
      code,
      { requiredDocs: dedup }
    )
    return { ok: true as const }
  },
})

export const resetRequiredDocs = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner')
    const existing = await ctx.db
      .query('tenantTransactionTypeOverrides')
      .withIndex('by_tenant_code', (q) =>
        q.eq('tenantId', tc.tenantId).eq('code', code)
      )
      .unique()
    if (existing) {
      await ctx.db.delete(existing._id)
      await recordAudit(
        ctx,
        tc,
        'reconciliationPolicy.resetRequiredDocs',
        'transaction_type',
        code,
        {}
      )
    }
    return { ok: true as const }
  },
})

// ─────────────────────────────────────────────────────────────────────
// Audit timeline
// ─────────────────────────────────────────────────────────────────────

const POLICY_ACTIONS = [
  'reconciliationPolicy.upsert',
  'reconciliationPolicy.reset',
  'reconciliationPolicy.resetAll',
  'reconciliationPolicy.setTolerances',
  'reconciliationPolicy.resetTolerances',
  'reconciliationPolicy.setRequiredDocs',
  'reconciliationPolicy.resetRequiredDocs',
] as const

/**
 * Recent policy / tolerance changes for the active tenant. Bounded so the
 * UI doesn't have to paginate; owners reviewing recent changes will rarely
 * need more than a couple of weeks.
 */
export const recentAuditEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner')
    const cap = Math.min(Math.max(limit ?? 20, 1), 100)
    // No tenant+action index — pull a small recent window by tenant and
    // filter in memory. Audit tables are small per tenant; keeping a
    // narrower index just for this view isn't worth the write cost.
    const rows = await ctx.db
      .query('auditEvents')
      .withIndex('by_tenant_time', (q) => q.eq('tenantId', tc.tenantId))
      .order('desc')
      .take(cap * 5)
    const filtered = rows.filter((r) =>
      (POLICY_ACTIONS as ReadonlyArray<string>).includes(r.action)
    )
    const sliced = filtered.slice(0, cap)

    // Resolve actor labels in one batch so the UI can show "Avery T." rather
    // than the raw memberId.
    const memberIds = Array.from(
      new Set(
        sliced
          .map((r) => r.actorMemberId)
          .filter((id): id is NonNullable<typeof id> => !!id)
      )
    )
    const members = await Promise.all(memberIds.map((id) => ctx.db.get(id)))
    const memberLabel = new Map<string, string>()
    for (const m of members) {
      if (!m) continue
      memberLabel.set(m._id, m.email)
    }

    return sliced.map((r) => ({
      id: r._id,
      action: r.action,
      occurredAt: r.occurredAt,
      resourceId: r.resourceId,
      actorType: r.actorType,
      actorLabel:
        r.actorMemberId && memberLabel.has(r.actorMemberId)
          ? memberLabel.get(r.actorMemberId)
          : r.actorType === 'system'
            ? 'system'
            : 'unknown',
      metadata: r.metadata as Record<string, unknown>,
    }))
  },
})
