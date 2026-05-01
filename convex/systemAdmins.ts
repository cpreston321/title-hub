/**
 * System admin allowlist — the only role that can create new organizations.
 *
 * These are deliberately `internalQuery`/`internalMutation` so they aren't
 * reachable from the browser. The `scripts/admin.ts` CLI invokes them via `npx
 * convex run`, which runs with deployment-level auth.
 */
import { ConvexError, v } from 'convex/values'
import {
  internalAction,
  internalMutation,
  internalQuery,
} from './_generated/server'
import { components, internal } from './_generated/api'
import { deleteDocumentCascade, scheduleExtractionFor } from './files'
import { createAuth } from './auth'

type AuthUser = { _id: string; email?: string; name?: string }

async function userByEmail(
  ctx: { runQuery: typeof components.betterAuth extends never ? never : any },
  email: string
): Promise<AuthUser | null> {
  const u = (await (ctx as { runQuery: Function }).runQuery(
    components.betterAuth.adapter.findOne,
    { model: 'user', where: [{ field: 'email', value: email }] }
  )) as AuthUser | null
  return u
}

async function userById(
  ctx: { runQuery: Function },
  id: string
): Promise<AuthUser | null> {
  const u = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: 'user',
    where: [{ field: '_id', value: id }],
  })) as AuthUser | null
  return u
}

export const list = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('systemAdmins').collect()
    return Promise.all(
      rows.map(async (a) => {
        const user = await userById(ctx, a.betterAuthUserId)
        return {
          betterAuthUserId: a.betterAuthUserId,
          email: user?.email ?? null,
          name: user?.name ?? null,
          addedAt: a.addedAt,
          addedBy: a.addedBy ?? null,
        }
      })
    )
  },
})

export const addByEmail = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const normalized = email.trim().toLowerCase()
    const user = await userByEmail(ctx, normalized)
    if (!user) {
      throw new ConvexError(
        `No user with email ${normalized}. They must sign up before being promoted.`
      )
    }

    const existing = await ctx.db
      .query('systemAdmins')
      .withIndex('by_user', (q) => q.eq('betterAuthUserId', user._id))
      .unique()
    if (existing) {
      return {
        ok: true,
        alreadyAdmin: true,
        email: normalized,
        betterAuthUserId: user._id,
      }
    }

    await ctx.db.insert('systemAdmins', {
      betterAuthUserId: user._id,
      addedAt: Date.now(),
      addedBy: 'cli',
    })
    return {
      ok: true,
      alreadyAdmin: false,
      email: normalized,
      betterAuthUserId: user._id,
    }
  },
})

export const removeByEmail = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const normalized = email.trim().toLowerCase()
    const user = await userByEmail(ctx, normalized)
    if (!user) {
      throw new ConvexError(`No user with email ${normalized}.`)
    }

    const existing = await ctx.db
      .query('systemAdmins')
      .withIndex('by_user', (q) => q.eq('betterAuthUserId', user._id))
      .unique()
    if (!existing) {
      return { ok: true, removed: false, email: normalized }
    }

    // Refuse to remove the last admin — that would lock everyone out of org
    // creation with no in-app recovery path.
    const all = await ctx.db.query('systemAdmins').collect()
    if (all.length <= 1) {
      throw new ConvexError(
        'Cannot remove the last system admin. Promote another user first.'
      )
    }

    await ctx.db.delete(existing._id)
    return { ok: true, removed: true, email: normalized }
  },
})

// Convenience for the CLI: list every tenant (org) on the deployment.
export const listTenants = internalQuery({
  args: {},
  handler: async (ctx) => {
    const tenants = await ctx.db.query('tenants').collect()
    return tenants.map((t) => ({
      tenantId: t._id,
      slug: t.slug,
      legalName: t.legalName,
      status: t.status,
      plan: t.plan,
      createdAt: t.createdAt,
    }))
  },
})

// ─────────────────────────────────────────────────────────────────────
// Test-data upload helpers (CLI-only)
// ─────────────────────────────────────────────────────────────────────
// These mirror parts of `convex/files.ts` but skip the per-request auth
// check, so the CLI can populate a tenant from local files without going
// through the browser. They run with deployment-level auth (npx convex run).

const propertyAddressV = v.object({
  line1: v.string(),
  line2: v.optional(v.string()),
  city: v.string(),
  state: v.string(),
  zip: v.string(),
})

async function tenantBySlug(
  ctx: { db: { query: (t: 'tenants') => any } },
  slug: string
) {
  const row = await ctx.db
    .query('tenants')
    .withIndex('by_slug', (q: any) => q.eq('slug', slug))
    .unique()
  return row
}

export const adminEnsureFile = internalMutation({
  args: {
    tenantSlug: v.string(),
    fileNumber: v.string(),
    countyName: v.string(),
    stateCode: v.string(),
    transactionType: v.string(),
    propertyAddress: v.optional(propertyAddressV),
    propertyApn: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tenant = await tenantBySlug(ctx, args.tenantSlug)
    if (!tenant) {
      throw new ConvexError(`No tenant with slug ${args.tenantSlug}`)
    }

    const existing = await ctx.db
      .query('files')
      .withIndex('by_tenant_filenumber', (q) =>
        q.eq('tenantId', tenant._id).eq('fileNumber', args.fileNumber)
      )
      .unique()
    if (existing) {
      return {
        fileId: existing._id,
        created: false,
        tenantId: tenant._id,
      }
    }

    const counties = await ctx.db
      .query('counties')
      .withIndex('by_state', (q) => q.eq('stateCode', args.stateCode))
      .collect()
    const county = counties.find(
      (c) => c.name.toLowerCase() === args.countyName.toLowerCase()
    )
    if (!county) {
      throw new ConvexError(
        `County not found: ${args.countyName} ${args.stateCode}. Run \`bun run admin seed-indiana\` first.`
      )
    }

    const fileId = await ctx.db.insert('files', {
      tenantId: tenant._id,
      fileNumber: args.fileNumber,
      stateCode: county.stateCode,
      countyId: county._id,
      transactionType: args.transactionType,
      status: 'opened',
      propertyAddress: args.propertyAddress,
      propertyApn: args.propertyApn,
      searchText: [
        args.fileNumber,
        args.transactionType,
        args.propertyApn ?? '',
        args.propertyAddress?.line1 ?? '',
        args.propertyAddress?.city ?? '',
        county.name,
      ]
        .join(' ')
        .toLowerCase(),
      openedAt: Date.now(),
    })

    await ctx.db.insert('auditEvents', {
      tenantId: tenant._id,
      actorType: 'system',
      action: 'file.created',
      resourceType: 'file',
      resourceId: fileId,
      metadata: { fileNumber: args.fileNumber, source: 'cli' },
      occurredAt: Date.now(),
    })

    return { fileId, created: true, tenantId: tenant._id }
  },
})

export const adminGenerateUploadUrl = internalMutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl()
  },
})

// Returns true if the file already has a document with the given docType +
// title combo. Lets the CLI skip a redundant upload.
export const adminFileHasDocument = internalQuery({
  args: {
    tenantSlug: v.string(),
    fileNumber: v.string(),
    docType: v.string(),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const tenant = await tenantBySlug(ctx, args.tenantSlug)
    if (!tenant) return false
    const file = await ctx.db
      .query('files')
      .withIndex('by_tenant_filenumber', (q) =>
        q.eq('tenantId', tenant._id).eq('fileNumber', args.fileNumber)
      )
      .unique()
    if (!file) return false
    const docs = await ctx.db
      .query('documents')
      .withIndex('by_tenant_file', (q) =>
        q.eq('tenantId', tenant._id).eq('fileId', file._id)
      )
      .collect()
    return docs.some(
      (d) => d.docType === args.docType && (d.title ?? '') === args.title
    )
  },
})

// Removes duplicate documents within each file: groups by (fileId, docType,
// title) and keeps the most recent upload, deleting the rest along with any
// extraction rows pointing to them and the underlying storage blob.
export const adminDedupeDocuments = internalMutation({
  args: { tenantSlug: v.string() },
  handler: async (ctx, { tenantSlug }) => {
    const tenant = await tenantBySlug(ctx, tenantSlug)
    if (!tenant) throw new ConvexError(`No tenant with slug ${tenantSlug}`)

    const docs = await ctx.db
      .query('documents')
      .withIndex('by_tenant_uploadedAt', (q) => q.eq('tenantId', tenant._id))
      .collect()

    const groups = new Map<string, typeof docs>()
    for (const d of docs) {
      if (!d.fileId) continue
      const key = `${d.fileId} ${d.docType} ${d.title ?? ''}`
      const list = groups.get(key) ?? []
      list.push(d)
      groups.set(key, list)
    }

    let removed = 0
    let storageRemoved = 0
    for (const list of groups.values()) {
      if (list.length <= 1) continue
      // Sort newest-first so we keep the latest upload.
      list.sort((a, b) => b.uploadedAt - a.uploadedAt)
      const [, ...stale] = list
      for (const d of stale) {
        await deleteDocumentCascade(ctx, tenant._id, d)
        removed++
        storageRemoved++
      }
    }

    if (removed > 0) {
      await ctx.db.insert('auditEvents', {
        tenantId: tenant._id,
        actorType: 'system',
        action: 'documents.deduped',
        resourceType: 'tenant',
        resourceId: tenant._id,
        metadata: { removed, storageRemoved, source: 'cli' },
        occurredAt: Date.now(),
      })
    }

    return { removed, storageRemoved }
  },
})

export const adminAddParty = internalMutation({
  args: {
    tenantSlug: v.string(),
    fileNumber: v.string(),
    partyType: v.union(
      v.literal('person'),
      v.literal('entity'),
      v.literal('trust'),
      v.literal('estate')
    ),
    legalName: v.string(),
    role: v.string(),
    capacity: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tenant = await tenantBySlug(ctx, args.tenantSlug)
    if (!tenant) throw new ConvexError(`No tenant with slug ${args.tenantSlug}`)

    const file = await ctx.db
      .query('files')
      .withIndex('by_tenant_filenumber', (q) =>
        q.eq('tenantId', tenant._id).eq('fileNumber', args.fileNumber)
      )
      .unique()
    if (!file) {
      throw new ConvexError(
        `No file ${args.fileNumber} in tenant ${args.tenantSlug}`
      )
    }

    // Skip if a party with the same legal name + role already exists on this
    // file (so re-running the seed is idempotent).
    const existingFileParties = await ctx.db
      .query('fileParties')
      .withIndex('by_tenant_file', (q) =>
        q.eq('tenantId', tenant._id).eq('fileId', file._id)
      )
      .collect()
    for (const fp of existingFileParties) {
      const p = await ctx.db.get(fp.partyId)
      if (
        p &&
        fp.role === args.role &&
        p.legalName.trim().toLowerCase() === args.legalName.trim().toLowerCase()
      ) {
        return {
          partyId: p._id,
          filePartyId: fp._id,
          created: false,
        }
      }
    }

    const partyId = await ctx.db.insert('parties', {
      tenantId: tenant._id,
      partyType: args.partyType,
      legalName: args.legalName.trim(),
    })

    const filePartyId = await ctx.db.insert('fileParties', {
      tenantId: tenant._id,
      fileId: file._id,
      partyId,
      role: args.role,
      capacity: args.capacity,
    })

    await ctx.db.insert('auditEvents', {
      tenantId: tenant._id,
      actorType: 'system',
      action: 'file.party_added',
      resourceType: 'file',
      resourceId: file._id,
      metadata: {
        partyId,
        filePartyId,
        role: args.role,
        legalName: args.legalName,
        source: 'cli',
      },
      occurredAt: Date.now(),
    })

    return { partyId, filePartyId, created: true }
  },
})

export const adminRecordDocument = internalMutation({
  args: {
    tenantSlug: v.string(),
    fileNumber: v.string(),
    storageId: v.id('_storage'),
    docType: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tenant = await tenantBySlug(ctx, args.tenantSlug)
    if (!tenant) throw new ConvexError(`No tenant with slug ${args.tenantSlug}`)

    const file = await ctx.db
      .query('files')
      .withIndex('by_tenant_filenumber', (q) =>
        q.eq('tenantId', tenant._id).eq('fileNumber', args.fileNumber)
      )
      .unique()
    if (!file) {
      throw new ConvexError(
        `No file ${args.fileNumber} in tenant ${args.tenantSlug}`
      )
    }

    // Pick any owner (or first member) as the uploader-of-record. Required
    // by schema; the audit metadata flags this row as CLI-sourced.
    const members = await ctx.db
      .query('tenantMembers')
      .withIndex('by_tenant_email', (q) => q.eq('tenantId', tenant._id))
      .collect()
    const fallback =
      members.find((m) => m.role === 'owner') ??
      members.find((m) => m.role === 'admin') ??
      members[0]
    if (!fallback) {
      throw new ConvexError(
        `Tenant ${args.tenantSlug} has no members — invite someone first.`
      )
    }

    const meta = await ctx.db.system.get(args.storageId)
    if (!meta) throw new ConvexError('STORAGE_NOT_FOUND')

    const docId = await ctx.db.insert('documents', {
      tenantId: tenant._id,
      fileId: file._id,
      docType: args.docType,
      title: args.title,
      storageId: args.storageId,
      contentType: meta.contentType,
      sizeBytes: meta.size,
      checksum: meta.sha256,
      uploadedByMemberId: fallback._id,
      uploadedAt: Date.now(),
    })

    await ctx.db.insert('auditEvents', {
      tenantId: tenant._id,
      actorMemberId: fallback._id,
      actorType: 'system',
      action: 'document.uploaded',
      resourceType: 'file',
      resourceId: file._id,
      metadata: {
        documentId: docId,
        docType: args.docType,
        sizeBytes: meta.size,
        source: 'cli',
      },
      occurredAt: Date.now(),
    })

    // Auto-extract: same as the public upload path.
    const extractionId = await scheduleExtractionFor(ctx, tenant._id, {
      documentId: docId,
      fileId: file._id,
      storageId: args.storageId,
      docType: args.docType,
    })

    await ctx.db.insert('auditEvents', {
      tenantId: tenant._id,
      actorMemberId: fallback._id,
      actorType: 'system',
      action: 'extraction.requested',
      resourceType: 'file',
      resourceId: file._id,
      metadata: {
        documentId: docId,
        extractionId,
        docType: args.docType,
        source: 'cli',
      },
      occurredAt: Date.now(),
    })

    return {
      docId,
      extractionId,
      fileId: file._id,
      sizeBytes: meta.size,
      contentType: meta.contentType,
    }
  },
})

// ─────────────────────────────────────────────────────────────────────
// Seed a user (email + password) and add them to a tenant
// ─────────────────────────────────────────────────────────────────────
// Drives `bun run admin seed-user`. Goes through Better Auth's own APIs so
// the password is hashed correctly and the org/member triggers fire (which
// in turn provision the app-side `tenantMembers` row).

export const tenantBySlugForSeed = internalQuery({
  args: { tenantSlug: v.string() },
  handler: async (ctx, { tenantSlug }) => {
    const t = await ctx.db
      .query('tenants')
      .withIndex('by_slug', (q) => q.eq('slug', tenantSlug))
      .unique()
    if (!t) return null
    return {
      tenantId: t._id,
      betterAuthOrgId: t.betterAuthOrgId,
      slug: t.slug,
      legalName: t.legalName,
    }
  },
})

type SeedUserResult = {
  userId: string
  email: string
  tenantId: string
  tenantSlug: string
  tenantName: string
  role: 'owner' | 'admin' | 'member'
  userCreated: boolean
  memberCreated: boolean
  passwordSet: boolean
}

// Shared password-writing path used by both seed-user and set-password. Hashes
// with `@better-auth/utils/password` (the function BA's default sign-in path
// also uses to verify), patches the credential account if one exists, or
// creates one if the user only had social providers. Round-trips the hash
// through verifyPassword as a self-test before returning — if scrypt produced
// something unverifiable we want to fail loudly rather than ship a bad hash.
async function writeCredentialPassword(
  ctx: {
    runQuery: (...args: any) => any
    runMutation: (...args: any) => any
  },
  userId: string,
  password: string,
): Promise<{ accountCreated: boolean }> {
  const { hashPassword, verifyPassword } = await import(
    '@better-auth/utils/password'
  )
  const hashed = await hashPassword(password)
  const verified = await verifyPassword(hashed, password)
  if (!verified) {
    throw new ConvexError(
      'PASSWORD_HASH_SELFCHECK_FAILED: hashPassword produced a hash that verifyPassword rejected. Refusing to write a bad credential.',
    )
  }

  const account = (await ctx.runQuery(
    components.betterAuth.adapter.findOne,
    {
      model: 'account',
      where: [
        { field: 'userId', value: userId },
        { field: 'providerId', value: 'credential' },
      ],
    },
  )) as { _id: string } | null

  const now = Date.now()
  if (account) {
    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: 'account',
        update: { password: hashed, updatedAt: now },
        where: [{ field: '_id', value: account._id }],
      },
    })
    return { accountCreated: false }
  }

  await ctx.runMutation(components.betterAuth.adapter.create, {
    input: {
      model: 'account',
      data: {
        accountId: userId,
        providerId: 'credential',
        userId,
        password: hashed,
        createdAt: now,
        updatedAt: now,
      },
    },
  })
  return { accountCreated: true }
}

export const seedUserAndAssign = internalAction({
  args: {
    email: v.string(),
    password: v.string(),
    name: v.string(),
    tenantSlug: v.string(),
    role: v.optional(
      v.union(v.literal('owner'), v.literal('admin'), v.literal('member'))
    ),
  },
  handler: async (
    ctx,
    { email, password, name, tenantSlug, role }
  ): Promise<SeedUserResult> => {
    const normalizedEmail = email.trim().toLowerCase()
    const finalRole = role ?? 'member'

    const tenant = (await ctx.runQuery(
      internal.systemAdmins.tenantBySlugForSeed,
      { tenantSlug }
    )) as {
      tenantId: string
      betterAuthOrgId: string
      slug: string
      legalName: string
    } | null
    if (!tenant) {
      throw new ConvexError(`No tenant with slug ${tenantSlug}`)
    }

    // Org-plugin endpoints aren't surfaced on the inferred API type when
    // BetterAuthOptions is widened, so the cast below is intentional.
    const auth = createAuth(ctx) as unknown as {
      api: {
        signUpEmail: (args: {
          body: { email: string; password: string; name: string }
        }) => Promise<{ user: { id: string } }>
        addMember: (args: {
          body: {
            userId: string
            organizationId: string
            role: 'owner' | 'admin' | 'member'
          }
        }) => Promise<unknown>
      }
    }

    // Reuse the existing user if email is already registered. This makes the
    // command safe to re-run and lets you add an existing user to a new org.
    const existing = (await ctx.runQuery(
      components.betterAuth.adapter.findOne,
      {
        model: 'user',
        where: [{ field: 'email', value: normalizedEmail }],
      }
    )) as { _id: string; email?: string } | null

    let userId: string
    let userCreated: boolean
    if (existing) {
      userId = existing._id
      userCreated = false
    } else {
      const result = await auth.api.signUpEmail({
        body: { email: normalizedEmail, password, name },
      })
      userId = result.user.id
      userCreated = true
    }

    // Always (re)write the credential password. signUpEmail also writes one
    // for new users, but doing it again here is harmless and means existing
    // users get the password they were just told they'd be given.
    await writeCredentialPassword(ctx, userId, password)

    // If they're already a member of this org, don't try to add again — BA's
    // addMember endpoint throws on duplicate.
    const memberAlready = (await ctx.runQuery(
      components.betterAuth.adapter.findOne,
      {
        model: 'member',
        where: [
          { field: 'organizationId', value: tenant.betterAuthOrgId },
          { field: 'userId', value: userId },
        ],
      }
    )) as { _id: string } | null

    let memberCreated = false
    if (!memberAlready) {
      await auth.api.addMember({
        body: {
          userId,
          organizationId: tenant.betterAuthOrgId,
          role: finalRole,
        },
      })
      memberCreated = true
    }

    return {
      userId,
      email: normalizedEmail,
      tenantId: tenant.tenantId,
      tenantSlug: tenant.slug,
      tenantName: tenant.legalName,
      role: finalRole,
      userCreated,
      memberCreated,
      passwordSet: true,
    }
  },
})

// ─────────────────────────────────────────────────────────────────────
// Seed county recording rules
// ─────────────────────────────────────────────────────────────────────
// Platform-shared (no tenantId), so we can seed without a tenant context.
// Mirrors `rules.seedPilotRules` but is callable from the CLI. Idempotent —
// existing (county, docType) rows are left alone.

const PILOT_COUNTY_FIPS: ReadonlyArray<{ fips: string; name: string }> = [
  { fips: '18097', name: 'Marion' },
  { fips: '18057', name: 'Hamilton' },
]

const PILOT_DOC_TYPES = [
  'deed',
  'mortgage',
  'release',
  'assignment',
  'deed_of_trust',
] as const

function pilotRulesFor(docType: string) {
  return {
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
  }
}

export const adminSeedRecordingRules = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const startOfYear = new Date(new Date().getFullYear(), 0, 1).getTime()

    const results: Array<{
      county: string
      fips: string
      inserted: number
      skipped: number
    }> = []

    let totalInserted = 0
    let totalSkipped = 0

    for (const { fips, name } of PILOT_COUNTY_FIPS) {
      const county = await ctx.db
        .query('counties')
        .withIndex('by_fips', (q) => q.eq('fipsCode', fips))
        .unique()
      if (!county) {
        throw new ConvexError(
          `County ${name} (${fips}) not found. Run \`bun run admin seed-indiana\` first.`,
        )
      }

      let inserted = 0
      let skipped = 0
      for (const docType of PILOT_DOC_TYPES) {
        const existing = await ctx.db
          .query('countyRecordingRules')
          .withIndex('by_county_doctype_version', (q) =>
            q.eq('countyId', county._id).eq('docType', docType),
          )
          .first()
        if (existing) {
          skipped++
          continue
        }
        await ctx.db.insert('countyRecordingRules', {
          countyId: county._id,
          docType,
          rules: pilotRulesFor(docType),
          effectiveFrom: startOfYear,
          version: 1,
          createdAt: now,
        })
        inserted++
      }

      totalInserted += inserted
      totalSkipped += skipped
      results.push({ county: name, fips, inserted, skipped })
    }

    return { totalInserted, totalSkipped, results }
  },
})

// ─────────────────────────────────────────────────────────────────────
// Set / reset a user's password
// ─────────────────────────────────────────────────────────────────────
// Hashes with Better Auth's default scrypt (`@better-auth/utils/password`)
// and patches the user's `credential` account row in the BA component, or
// creates one if the user only had social providers. Bypasses email reset.

type SetPasswordResult = {
  email: string
  userId: string
  accountCreated: boolean
}

export const setUserPassword = internalAction({
  args: { email: v.string(), password: v.string() },
  handler: async (
    ctx,
    { email, password },
  ): Promise<SetPasswordResult> => {
    const normalizedEmail = email.trim().toLowerCase()

    const user = (await ctx.runQuery(
      components.betterAuth.adapter.findOne,
      {
        model: 'user',
        where: [{ field: 'email', value: normalizedEmail }],
      },
    )) as { _id: string; email?: string } | null
    if (!user) {
      throw new ConvexError(`No user with email ${normalizedEmail}`)
    }

    const { accountCreated } = await writeCredentialPassword(
      ctx,
      user._id,
      password,
    )
    return { email: normalizedEmail, userId: user._id, accountCreated }
  },
})
