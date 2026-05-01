import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import type { QueryCtx } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import { requireRole, requireTenant } from './lib/tenant'

export const RECORDABLE_DOC_TYPES = [
  'deed',
  'mortgage',
  'release',
  'assignment',
  'deed_of_trust',
] as const

const docTypeValidator = v.union(
  v.literal('deed'),
  v.literal('mortgage'),
  v.literal('release'),
  v.literal('assignment'),
  v.literal('deed_of_trust')
)

const rulesPayload = v.object({
  pageSize: v.optional(v.string()),
  margins: v.optional(
    v.object({
      top: v.number(),
      bottom: v.number(),
      left: v.number(),
      right: v.number(),
    })
  ),
  requiredExhibits: v.array(v.string()),
  feeSchedule: v.any(),
  signaturePageRequirements: v.any(),
  notaryRequirements: v.any(),
})

/**
 * Pure resolver per spec §6: returns the rule version effective at `asOf` for a
 * given county + docType, or null if none is configured. Files in flight always
 * resolve against the rule effective at openedAt.
 */
export async function resolveRecordingRulesAt(
  ctx: QueryCtx,
  countyId: Id<'counties'>,
  docType: string,
  asOf: number
): Promise<Doc<'countyRecordingRules'> | null> {
  const rule = await ctx.db
    .query('countyRecordingRules')
    .withIndex('by_county_doctype_effective', (q) =>
      q
        .eq('countyId', countyId)
        .eq('docType', docType)
        .lte('effectiveFrom', asOf)
    )
    .order('desc')
    .first()

  if (!rule) return null
  if (rule.effectiveTo !== undefined && rule.effectiveTo < asOf) return null
  return rule
}

export const resolveForFile = query({
  args: {
    fileId: v.id('files'),
    docType: docTypeValidator,
  },
  handler: async (ctx, { fileId, docType }) => {
    const tc = await requireTenant(ctx)
    const file = await ctx.db.get(fileId)
    if (!file || file.tenantId !== tc.tenantId) {
      throw new ConvexError('FILE_NOT_FOUND')
    }
    const rule = await resolveRecordingRulesAt(
      ctx,
      file.countyId,
      docType,
      file.openedAt
    )
    return rule
  },
})

export const resolveForCounty = query({
  args: {
    countyId: v.id('counties'),
    docType: docTypeValidator,
    asOf: v.optional(v.number()),
  },
  handler: async (ctx, { countyId, docType, asOf }) => {
    await requireTenant(ctx)
    return await resolveRecordingRulesAt(
      ctx,
      countyId,
      docType,
      asOf ?? Date.now()
    )
  },
})

export const listForCounty = query({
  args: { countyId: v.id('counties') },
  handler: async (ctx, { countyId }) => {
    await requireTenant(ctx)
    return await ctx.db
      .query('countyRecordingRules')
      .withIndex('by_county_doctype_effective', (q) =>
        q.eq('countyId', countyId)
      )
      .order('desc')
      .take(200)
  },
})

export const publishRule = mutation({
  args: {
    countyId: v.id('counties'),
    docType: docTypeValidator,
    rules: rulesPayload,
    effectiveFrom: v.number(),
    supersedes: v.optional(v.id('countyRecordingRules')),
  },
  handler: async (
    ctx,
    { countyId, docType, rules, effectiveFrom, supersedes }
  ) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner')

    const county = await ctx.db.get(countyId)
    if (!county) throw new ConvexError('COUNTY_NOT_FOUND')

    const existingNewest = await ctx.db
      .query('countyRecordingRules')
      .withIndex('by_county_doctype_version', (q) =>
        q.eq('countyId', countyId).eq('docType', docType)
      )
      .order('desc')
      .first()

    const nextVersion = (existingNewest?.version ?? 0) + 1

    if (supersedes) {
      const prior = await ctx.db.get(supersedes)
      if (!prior) throw new ConvexError('SUPERSEDED_RULE_NOT_FOUND')
      if (prior.countyId !== countyId || prior.docType !== docType) {
        throw new ConvexError('SUPERSEDED_RULE_MISMATCH')
      }
      if (prior.effectiveTo === undefined) {
        await ctx.db.patch(supersedes, { effectiveTo: effectiveFrom })
      }
    }

    const id = await ctx.db.insert('countyRecordingRules', {
      countyId,
      docType,
      rules,
      effectiveFrom,
      version: nextVersion,
      authoredByMemberId: tc.memberId,
      createdAt: Date.now(),
    })

    return { ruleId: id, version: nextVersion }
  },
})

// Seed Marion + Hamilton recording rules. Idempotent — skips if rules already
// exist for that county+docType. Run once per environment after seed.indiana.
export const seedPilotRules = mutation({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, 'owner')

    const marion = await ctx.db
      .query('counties')
      .withIndex('by_fips', (q) => q.eq('fipsCode', '18097'))
      .unique()
    const hamilton = await ctx.db
      .query('counties')
      .withIndex('by_fips', (q) => q.eq('fipsCode', '18057'))
      .unique()
    if (!marion || !hamilton) {
      throw new ConvexError('INDIANA_COUNTIES_NOT_SEEDED')
    }

    const now = Date.now()
    const startOfYear = new Date(new Date().getFullYear(), 0, 1).getTime()

    const standardRules = (docType: string) => ({
      pageSize: 'letter',
      margins: { top: 2, bottom: 1, left: 1, right: 1 },
      requiredExhibits:
        docType === 'deed'
          ? ['legal_description', 'sales_disclosure_form']
          : docType === 'mortgage'
            ? ['legal_description']
            : [],
      feeSchedule: {
        firstPage: 25,
        additionalPage: 5,
        salesDisclosureFee: docType === 'deed' ? 20 : 0,
      },
      signaturePageRequirements: {
        notarized: true,
        witnessRequired: false,
        printedNameBeneathSignature: true,
      },
      notaryRequirements: {
        sealRequired: true,
        commissionExpirationStatement: true,
      },
    })

    let inserted = 0
    for (const county of [marion, hamilton]) {
      for (const docType of [
        'deed',
        'mortgage',
        'release',
        'assignment',
        'deed_of_trust',
      ] as const) {
        const existing = await ctx.db
          .query('countyRecordingRules')
          .withIndex('by_county_doctype_version', (q) =>
            q.eq('countyId', county._id).eq('docType', docType)
          )
          .first()
        if (existing) continue
        await ctx.db.insert('countyRecordingRules', {
          countyId: county._id,
          docType,
          rules: standardRules(docType),
          effectiveFrom: startOfYear,
          version: 1,
          authoredByMemberId: tc.memberId,
          createdAt: now,
        })
        inserted++
      }
    }
    return { rulesInserted: inserted }
  },
})
