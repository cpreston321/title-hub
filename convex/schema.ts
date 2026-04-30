import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export const roles = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("processor"),
  v.literal("closer"),
  v.literal("reviewer"),
  v.literal("readonly"),
)

export const tenantStatus = v.union(
  v.literal("trial"),
  v.literal("active"),
  v.literal("suspended"),
  v.literal("churned"),
)

export const memberStatus = v.union(
  v.literal("active"),
  v.literal("suspended"),
)

export const fileStatus = v.union(
  v.literal("opened"),
  v.literal("in_exam"),
  v.literal("cleared"),
  v.literal("closing"),
  v.literal("funded"),
  v.literal("recorded"),
  v.literal("policied"),
  v.literal("cancelled"),
)

export const partyType = v.union(
  v.literal("person"),
  v.literal("entity"),
  v.literal("trust"),
  v.literal("estate"),
)

export const propertyAddress = v.object({
  line1: v.string(),
  line2: v.optional(v.string()),
  city: v.string(),
  state: v.string(),
  zip: v.string(),
})

export default defineSchema({
  // ───── Tenancy ────────────────────────────────────────────────
  tenants: defineTable({
    slug: v.string(),
    legalName: v.string(),
    status: tenantStatus,
    plan: v.string(),
    primaryState: v.optional(v.string()),
    npiKmsKeyArn: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_slug", ["slug"]),

  tenantMembers: defineTable({
    tenantId: v.id("tenants"),
    betterAuthUserId: v.string(),
    email: v.string(),
    role: roles,
    canViewNpi: v.boolean(),
    status: memberStatus,
    lastLoginAt: v.optional(v.number()),
  })
    .index("by_tenant_email", ["tenantId", "email"])
    .index("by_betterAuthUser", ["betterAuthUserId"])
    .index("by_betterAuthUser_tenant", ["betterAuthUserId", "tenantId"]),

  userPreferences: defineTable({
    betterAuthUserId: v.string(),
    activeTenantId: v.optional(v.id("tenants")),
  }).index("by_betterAuthUser", ["betterAuthUserId"]),

  apiKeys: defineTable({
    tenantId: v.id("tenants"),
    name: v.string(),
    prefix: v.string(),
    keyHash: v.string(),
    scopes: v.array(v.string()),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_tenant", ["tenantId"])
    .index("by_prefix", ["prefix"]),

  auditEvents: defineTable({
    tenantId: v.id("tenants"),
    actorMemberId: v.optional(v.id("tenantMembers")),
    actorType: v.string(),
    action: v.string(),
    resourceType: v.string(),
    resourceId: v.string(),
    metadata: v.any(),
    ipAddress: v.optional(v.string()),
    occurredAt: v.number(),
  })
    .index("by_tenant_time", ["tenantId", "occurredAt"])
    .index("by_tenant_resource", ["tenantId", "resourceType", "resourceId"]),

  // ───── Platform-shared globals (no tenantId) ──────────────────
  states: defineTable({
    code: v.string(),
    name: v.string(),
  }).index("by_code", ["code"]),

  counties: defineTable({
    fipsCode: v.string(),
    stateCode: v.string(),
    name: v.string(),
    recordingOffice: v.optional(v.string()),
    timezone: v.string(),
  })
    .index("by_fips", ["fipsCode"])
    .index("by_state", ["stateCode"]),

  underwriters: defineTable({
    code: v.string(),
    name: v.string(),
  }).index("by_code", ["code"]),

  // ───── Sprint 1: files / parties / documents ──────────────────
  files: defineTable({
    tenantId: v.id("tenants"),
    fileNumber: v.string(),
    externalRefs: v.optional(
      v.object({
        softproId: v.optional(v.string()),
        qualiaId: v.optional(v.string()),
        reswareId: v.optional(v.string()),
      }),
    ),
    stateCode: v.string(),
    countyId: v.id("counties"),
    transactionType: v.string(),
    underwriterId: v.optional(v.id("underwriters")),
    status: fileStatus,
    propertyApn: v.optional(v.string()),
    propertyAddress: v.optional(propertyAddress),
    openedAt: v.number(),
    targetCloseDate: v.optional(v.number()),
    closedAt: v.optional(v.number()),
  })
    .index("by_tenant_filenumber", ["tenantId", "fileNumber"])
    .index("by_tenant_status", ["tenantId", "status"])
    .index("by_tenant_county", ["tenantId", "countyId"])
    .index("by_tenant_openedAt", ["tenantId", "openedAt"]),

  parties: defineTable({
    tenantId: v.id("tenants"),
    partyType: partyType,
    legalName: v.string(),
    dba: v.optional(v.string()),
    formationState: v.optional(v.string()),
    entitySubtype: v.optional(v.string()),
    einOrSsnToken: v.optional(v.string()),
  }).index("by_tenant_legalname", ["tenantId", "legalName"]),

  fileParties: defineTable({
    tenantId: v.id("tenants"),
    fileId: v.id("files"),
    partyId: v.id("parties"),
    role: v.string(),
    capacity: v.optional(v.string()),
    ownershipPct: v.optional(v.number()),
  })
    .index("by_tenant_file", ["tenantId", "fileId"])
    .index("by_tenant_party", ["tenantId", "partyId"]),

  documents: defineTable({
    tenantId: v.id("tenants"),
    fileId: v.optional(v.id("files")),
    docType: v.string(),
    title: v.optional(v.string()),
    storageId: v.id("_storage"),
    contentType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    checksum: v.optional(v.string()),
    pageCount: v.optional(v.number()),
    ocrStatus: v.optional(v.string()),
    uploadedByMemberId: v.id("tenantMembers"),
    uploadedAt: v.number(),
  })
    .index("by_tenant_file", ["tenantId", "fileId"])
    .index("by_tenant_uploadedAt", ["tenantId", "uploadedAt"]),
})
