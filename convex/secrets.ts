import { ConvexError, v } from "convex/values"
import { internalMutation, mutation, query } from "./_generated/server"
import type { MutationCtx } from "./_generated/server"
import {
  requireNpiAccess,
  requireRole,
  requireTenant,
  type TenantContext,
} from "./lib/tenant"
import { recordAudit } from "./lib/audit"
import {
  activeProvider,
  decryptWithRawKey,
  encryptWithRawKey,
  generateRawKey,
  newToken,
} from "./lib/crypto"

const editorRoles = ["owner", "admin", "processor"] as const
const fieldKind = v.union(
  v.literal("ssn"),
  v.literal("ein"),
  v.literal("account"),
  v.literal("dob"),
)

async function activeKey(ctx: MutationCtx, tc: TenantContext) {
  const key = await ctx.db
    .query("tenantCryptoKeys")
    .withIndex("by_tenant_active", (q) =>
      q.eq("tenantId", tc.tenantId).eq("status", "active"),
    )
    .order("desc")
    .first()
  if (!key) throw new ConvexError("TENANT_KEY_NOT_PROVISIONED")
  return key
}

export const issue = mutation({
  args: {
    fieldKind,
    plaintext: v.string(),
  },
  handler: async (ctx, { fieldKind, plaintext }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)

    const key = await activeKey(ctx, tc)
    if (!key.rawKey) throw new ConvexError("TENANT_KEY_OPAQUE")

    const { ciphertext, iv } = await encryptWithRawKey(key.rawKey, plaintext)
    const token = newToken()

    await ctx.db.insert("npiSecrets", {
      tenantId: tc.tenantId,
      token,
      ciphertext,
      iv,
      keyRef: key.keyRef,
      fieldKind,
      createdAt: Date.now(),
    })

    await recordAudit(ctx, tc, "npi.issued", "npi", token, { fieldKind })
    return { token }
  },
})

export const reveal = mutation({
  args: {
    token: v.string(),
    purpose: v.optional(v.string()),
    fileId: v.optional(v.id("files")),
  },
  handler: async (ctx, { token, purpose, fileId }) => {
    const tc = await requireTenant(ctx)
    requireNpiAccess(tc)

    const secret = await ctx.db
      .query("npiSecrets")
      .withIndex("by_tenant_token", (q) =>
        q.eq("tenantId", tc.tenantId).eq("token", token),
      )
      .unique()
    if (!secret) throw new ConvexError("TOKEN_NOT_FOUND")
    if (secret.erased) throw new ConvexError("TENANT_KEY_DESTROYED")

    const keyRow = await ctx.db
      .query("tenantCryptoKeys")
      .withIndex("by_tenant_keyRef", (q) =>
        q.eq("tenantId", tc.tenantId).eq("keyRef", secret.keyRef),
      )
      .unique()
    if (!keyRow || keyRow.status === "destroyed" || !keyRow.rawKey) {
      throw new ConvexError("TENANT_KEY_DESTROYED")
    }

    const plaintext = await decryptWithRawKey(
      keyRow.rawKey,
      secret.ciphertext,
      secret.iv,
    )

    // Elevated audit (per spec §4: "the read is logged with elevated audit detail")
    await recordAudit(
      ctx,
      tc,
      "npi.viewed",
      fileId ? "file" : "npi",
      fileId ?? token,
      {
        token,
        fieldKind: secret.fieldKind,
        purpose: purpose ?? null,
      },
    )

    return { plaintext, fieldKind: secret.fieldKind }
  },
})

export const provisionForTenant = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const existing = await ctx.db
      .query("tenantCryptoKeys")
      .withIndex("by_tenant_active", (q) =>
        q.eq("tenantId", tenantId).eq("status", "active"),
      )
      .first()
    if (existing) return { keyRef: existing.keyRef, alreadyProvisioned: true }

    const provider = activeProvider()
    const keyRef =
      provider === "mock"
        ? `mock:${crypto.randomUUID()}`
        : `arn:aws:kms:REPLACE-ME:tenant/${tenantId}`

    await ctx.db.insert("tenantCryptoKeys", {
      tenantId,
      keyRef,
      provider,
      rawKey: provider === "mock" ? generateRawKey() : undefined,
      status: "active",
      createdAt: Date.now(),
    })

    await ctx.db.patch(tenantId, { npiKmsKeyArn: keyRef })
    return { keyRef, alreadyProvisioned: false }
  },
})

export const eraseTenant = mutation({
  args: { tenantId: v.id("tenants"), confirm: v.literal("ERASE") },
  handler: async (ctx, { tenantId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, "owner")
    if (tc.tenantId !== tenantId) throw new ConvexError("WRONG_TENANT")

    const keys = await ctx.db
      .query("tenantCryptoKeys")
      .withIndex("by_tenant_active", (q) =>
        q.eq("tenantId", tenantId).eq("status", "active"),
      )
      .take(50)

    let destroyedKeys = 0
    for (const k of keys) {
      await ctx.db.patch(k._id, {
        status: "destroyed",
        rawKey: undefined,
        destroyedAt: Date.now(),
      })
      destroyedKeys++
    }

    let erasedSecrets = 0
    let cursor: string | null = null
    while (true) {
      const page = await ctx.db
        .query("npiSecrets")
        .withIndex("by_tenant_createdAt", (q) => q.eq("tenantId", tenantId))
        .paginate({ numItems: 100, cursor })
      for (const s of page.page) {
        if (s.erased) continue
        await ctx.db.patch(s._id, {
          erased: true,
          ciphertext: new ArrayBuffer(0),
          iv: new ArrayBuffer(0),
        })
        erasedSecrets++
      }
      if (page.isDone) break
      cursor = page.continueCursor
    }

    await recordAudit(
      ctx,
      tc,
      "tenant.npi_erased",
      "tenant",
      tenantId,
      { destroyedKeys, erasedSecrets },
    )

    return { destroyedKeys, erasedSecrets }
  },
})

export const tokensForTenant = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const tc = await requireTenant(ctx)
    const cap = Math.min(limit ?? 50, 200)
    const rows = await ctx.db
      .query("npiSecrets")
      .withIndex("by_tenant_createdAt", (q) => q.eq("tenantId", tc.tenantId))
      .order("desc")
      .take(cap)
    return rows.map((r) => ({
      _id: r._id,
      token: r.token,
      fieldKind: r.fieldKind,
      keyRef: r.keyRef,
      erased: r.erased ?? false,
      createdAt: r.createdAt,
    }))
  },
})
