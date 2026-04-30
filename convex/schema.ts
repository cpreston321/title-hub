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
  // 1:1 with Better Auth `organization` rows in the betterAuth component.
  // betterAuthOrgId is the join key resolved from session.activeOrganizationId.
  tenants: defineTable({
    slug: v.string(),
    legalName: v.string(),
    status: tenantStatus,
    plan: v.string(),
    primaryState: v.optional(v.string()),
    npiKmsKeyArn: v.optional(v.string()),
    betterAuthOrgId: v.string(),
    createdAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_better_auth_org", ["betterAuthOrgId"]),

  // App-side membership: role + canViewNpi flags. Better Auth's `member` table
  // is the source of truth for org membership; tenantMembers carries the
  // app-specific role enum and NPI gating that BA's "owner|admin|member"
  // doesn't express.
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

  underwriterEndorsementCodes: defineTable({
    underwriterId: v.id("underwriters"),
    stateCode: v.string(),
    endorsementCode: v.string(),
    description: v.string(),
    premiumRule: v.any(),
  }).index("by_underwriter_state", ["underwriterId", "stateCode"]),

  transactionTypes: defineTable({
    code: v.string(),
    name: v.string(),
    requiredDocs: v.array(v.string()),
  }).index("by_code", ["code"]),

  countyRecordingRules: defineTable({
    countyId: v.id("counties"),
    docType: v.string(),
    rules: v.object({
      pageSize: v.optional(v.string()),
      margins: v.optional(
        v.object({
          top: v.number(),
          bottom: v.number(),
          left: v.number(),
          right: v.number(),
        }),
      ),
      requiredExhibits: v.array(v.string()),
      feeSchedule: v.any(),
      signaturePageRequirements: v.any(),
      notaryRequirements: v.any(),
    }),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    version: v.number(),
    authoredByMemberId: v.optional(v.id("tenantMembers")),
    createdAt: v.number(),
  })
    .index("by_county_doctype_effective", [
      "countyId",
      "docType",
      "effectiveFrom",
    ])
    .index("by_county_doctype_version", [
      "countyId",
      "docType",
      "version",
    ]),

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
    // Denormalized full-text blob: fileNumber + transactionType + APN + address + county.
    // Populated by `files.create` and the `search.backfillFileSearchText` mutation.
    searchText: v.optional(v.string()),
    openedAt: v.number(),
    targetCloseDate: v.optional(v.number()),
    closedAt: v.optional(v.number()),
  })
    .index("by_tenant_filenumber", ["tenantId", "fileNumber"])
    .index("by_tenant_status", ["tenantId", "status"])
    .index("by_tenant_county", ["tenantId", "countyId"])
    .index("by_tenant_openedAt", ["tenantId", "openedAt"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["tenantId"],
    }),

  parties: defineTable({
    tenantId: v.id("tenants"),
    partyType: partyType,
    legalName: v.string(),
    dba: v.optional(v.string()),
    formationState: v.optional(v.string()),
    entitySubtype: v.optional(v.string()),
    einOrSsnToken: v.optional(v.string()),
  })
    .index("by_tenant_legalname", ["tenantId", "legalName"])
    .searchIndex("search_legalname", {
      searchField: "legalName",
      filterFields: ["tenantId"],
    }),

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

  // ───── Sprint 4: extraction + reconciliation ──────────────────
  documentExtractions: defineTable({
    tenantId: v.id("tenants"),
    fileId: v.id("files"),
    documentId: v.id("documents"),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("succeeded"),
      v.literal("failed"),
    ),
    payload: v.optional(v.any()),
    errorMessage: v.optional(v.string()),
    modelId: v.optional(v.string()),
    source: v.union(v.literal("claude"), v.literal("mock")),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_tenant_file", ["tenantId", "fileId"])
    .index("by_tenant_document", ["tenantId", "documentId"]),

  reconciliationFindings: defineTable({
    tenantId: v.id("tenants"),
    fileId: v.id("files"),
    findingType: v.string(),
    severity: v.union(
      v.literal("info"),
      v.literal("warn"),
      v.literal("block"),
    ),
    message: v.string(),
    involvedDocumentIds: v.array(v.id("documents")),
    involvedFields: v.array(v.string()),
    rawDetail: v.any(),
    status: v.union(
      v.literal("open"),
      v.literal("acknowledged"),
      v.literal("resolved"),
      v.literal("dismissed"),
    ),
    resolvedByMemberId: v.optional(v.id("tenantMembers")),
    resolvedAt: v.optional(v.number()),
    // When a processor closes a mismatch by picking which document is
    // authoritative, we record the chosen document and the value taken from it.
    // resolvedValue is a free-form snapshot (price, name string, etc.) — the
    // exact shape varies by findingType.
    resolvedDocumentId: v.optional(v.id("documents")),
    resolvedValue: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_tenant_file", ["tenantId", "fileId"])
    .index("by_tenant_file_status", ["tenantId", "fileId", "status"])
    .index("by_tenant_status", ["tenantId", "status"])
    .searchIndex("search_message", {
      searchField: "message",
      filterFields: ["tenantId"],
    }),

  webhookEndpoints: defineTable({
    tenantId: v.id("tenants"),
    url: v.string(),
    secret: v.string(),
    events: v.array(v.string()),
    enabled: v.boolean(),
    createdAt: v.number(),
  }).index("by_tenant", ["tenantId"]),

  webhookDeliveries: defineTable({
    tenantId: v.id("tenants"),
    endpointId: v.id("webhookEndpoints"),
    event: v.string(),
    payload: v.any(),
    status: v.union(
      v.literal("pending"),
      v.literal("succeeded"),
      v.literal("failed"),
    ),
    attemptCount: v.number(),
    lastAttemptAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_tenant_status", ["tenantId", "status"])
    .index("by_tenant_endpoint", ["tenantId", "endpointId"]),

  // ───── Sprint 2: NPI tokenization ─────────────────────────────
  npiSecrets: defineTable({
    tenantId: v.id("tenants"),
    token: v.string(),                  // npi_tok_...
    ciphertext: v.bytes(),
    iv: v.bytes(),
    keyRef: v.string(),                 // KMS ARN, or "mock:<keyId>" for dev
    fieldKind: v.union(
      v.literal("ssn"),
      v.literal("ein"),
      v.literal("account"),
      v.literal("dob"),
    ),
    erased: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_tenant_token", ["tenantId", "token"])
    .index("by_tenant_createdAt", ["tenantId", "createdAt"]),

  tenantCryptoKeys: defineTable({
    tenantId: v.id("tenants"),
    keyRef: v.string(),                 // matches npiSecrets.keyRef
    provider: v.union(
      v.literal("mock"),
      v.literal("aws-kms"),
    ),
    rawKey: v.optional(v.bytes()),      // mock-only; for aws-kms this is null
    status: v.union(
      v.literal("active"),
      v.literal("destroyed"),
    ),
    createdAt: v.number(),
    destroyedAt: v.optional(v.number()),
  })
    .index("by_tenant_active", ["tenantId", "status"])
    .index("by_tenant_keyRef", ["tenantId", "keyRef"]),
})
