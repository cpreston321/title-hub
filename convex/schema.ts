import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export const roles = v.union(
  v.literal('owner'),
  v.literal('admin'),
  v.literal('processor'),
  v.literal('closer'),
  v.literal('reviewer'),
  v.literal('readonly')
)

export const tenantStatus = v.union(
  v.literal('trial'),
  v.literal('active'),
  v.literal('suspended'),
  v.literal('churned')
)

export const memberStatus = v.union(v.literal('active'), v.literal('suspended'))

export const fileStatus = v.union(
  v.literal('opened'),
  v.literal('in_exam'),
  v.literal('cleared'),
  v.literal('closing'),
  v.literal('funded'),
  v.literal('recorded'),
  v.literal('policied'),
  v.literal('cancelled')
)

export const partyType = v.union(
  v.literal('person'),
  v.literal('entity'),
  v.literal('trust'),
  v.literal('estate')
)

export const propertyAddress = v.object({
  line1: v.string(),
  line2: v.optional(v.string()),
  city: v.string(),
  state: v.string(),
  zip: v.string(),
})

// ───── County Connect snapshot shapes ─────────────────────────────
// Provider-agnostic record shapes for the propertySnapshots table and the
// public actions in countyConnect.ts. Keep both in sync — TS types are
// derived via `Infer<typeof xxxV>` in countyConnect.ts so drift is
// caught at compile time.

export const propertyProfileV = v.object({
  attomId: v.union(v.string(), v.null()),
  apn: v.union(v.string(), v.null()),
  address: v.object({
    line1: v.string(),
    city: v.string(),
    state: v.string(),
    zip: v.string(),
  }),
  owner: v.object({
    name: v.union(v.string(), v.null()),
    mailingAddress: v.union(v.string(), v.null()),
  }),
  characteristics: v.object({
    yearBuilt: v.union(v.number(), v.null()),
    livingAreaSqft: v.union(v.number(), v.null()),
    lotSizeSqft: v.union(v.number(), v.null()),
    propertyType: v.union(v.string(), v.null()),
  }),
  lastSale: v.union(
    v.object({
      date: v.union(v.string(), v.null()),
      price: v.union(v.number(), v.null()),
      documentType: v.union(v.string(), v.null()),
    }),
    v.null()
  ),
})

export const recordedDocumentV = v.object({
  documentType: v.string(),
  recordingDate: v.union(v.string(), v.null()),
  documentNumber: v.union(v.string(), v.null()),
  bookPage: v.union(v.string(), v.null()),
  grantor: v.union(v.string(), v.null()),
  grantee: v.union(v.string(), v.null()),
  amount: v.union(v.number(), v.null()),
})

export const taxDataV = v.object({
  taxYear: v.union(v.number(), v.null()),
  taxAmount: v.union(v.number(), v.null()),
  assessedValue: v.union(v.number(), v.null()),
  marketValue: v.union(v.number(), v.null()),
  taxRateAreaCode: v.union(v.string(), v.null()),
  exemptions: v.array(v.string()),
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
    .index('by_slug', ['slug'])
    .index('by_better_auth_org', ['betterAuthOrgId']),

  // App-side membership: role + canViewNpi flags. Better Auth's `member` table
  // is the source of truth for org membership; tenantMembers carries the
  // app-specific role enum and NPI gating that BA's "owner|admin|member"
  // doesn't express.
  tenantMembers: defineTable({
    tenantId: v.id('tenants'),
    betterAuthUserId: v.string(),
    email: v.string(),
    role: roles,
    canViewNpi: v.boolean(),
    status: memberStatus,
    lastLoginAt: v.optional(v.number()),
  })
    .index('by_tenant_email', ['tenantId', 'email'])
    .index('by_betterAuthUser', ['betterAuthUserId'])
    .index('by_betterAuthUser_tenant', ['betterAuthUserId', 'tenantId']),

  apiKeys: defineTable({
    tenantId: v.id('tenants'),
    name: v.string(),
    prefix: v.string(),
    keyHash: v.string(),
    scopes: v.array(v.string()),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_tenant', ['tenantId'])
    .index('by_prefix', ['prefix']),

  auditEvents: defineTable({
    tenantId: v.id('tenants'),
    actorMemberId: v.optional(v.id('tenantMembers')),
    actorType: v.string(),
    action: v.string(),
    resourceType: v.string(),
    resourceId: v.string(),
    metadata: v.any(),
    ipAddress: v.optional(v.string()),
    occurredAt: v.number(),
  })
    .index('by_tenant_time', ['tenantId', 'occurredAt'])
    .index('by_tenant_resource', ['tenantId', 'resourceType', 'resourceId']),

  // ───── Platform-shared globals (no tenantId) ──────────────────
  states: defineTable({
    code: v.string(),
    name: v.string(),
  }).index('by_code', ['code']),

  counties: defineTable({
    fipsCode: v.string(),
    stateCode: v.string(),
    name: v.string(),
    recordingOffice: v.optional(v.string()),
    timezone: v.string(),
  })
    .index('by_fips', ['fipsCode'])
    .index('by_state', ['stateCode']),

  underwriters: defineTable({
    code: v.string(),
    name: v.string(),
  }).index('by_code', ['code']),

  underwriterEndorsementCodes: defineTable({
    underwriterId: v.id('underwriters'),
    stateCode: v.string(),
    endorsementCode: v.string(),
    description: v.string(),
    premiumRule: v.any(),
  }).index('by_underwriter_state', ['underwriterId', 'stateCode']),

  transactionTypes: defineTable({
    code: v.string(),
    name: v.string(),
    requiredDocs: v.array(v.string()),
  }).index('by_code', ['code']),

  countyRecordingRules: defineTable({
    countyId: v.id('counties'),
    docType: v.string(),
    rules: v.object({
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
    }),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    version: v.number(),
    authoredByMemberId: v.optional(v.id('tenantMembers')),
    createdAt: v.number(),
  })
    .index('by_county_doctype_effective', [
      'countyId',
      'docType',
      'effectiveFrom',
    ])
    .index('by_county_doctype_version', ['countyId', 'docType', 'version']),

  // ───── Sprint 1: files / parties / documents ──────────────────
  files: defineTable({
    tenantId: v.id('tenants'),
    fileNumber: v.string(),
    externalRefs: v.optional(
      v.object({
        softproId: v.optional(v.string()),
        qualiaId: v.optional(v.string()),
        reswareId: v.optional(v.string()),
      })
    ),
    stateCode: v.string(),
    countyId: v.id('counties'),
    transactionType: v.string(),
    underwriterId: v.optional(v.id('underwriters')),
    status: fileStatus,
    propertyApn: v.optional(v.string()),
    propertyAddress: v.optional(propertyAddress),
    // Denormalized full-text blob: fileNumber + transactionType + APN + address + county.
    // Populated by `files.create` and the `search.backfillFileSearchText` mutation.
    searchText: v.optional(v.string()),
    openedAt: v.number(),
    targetCloseDate: v.optional(v.number()),
    closedAt: v.optional(v.number()),
    // ── Reconciled ground truth (post-`resolveWith` system of record) ──
    // Set by reconciliation.resolveWith when a processor picks the
    // authoritative value. Downstream closing-doc generation reads from
    // here, not from per-document extractions.
    purchasePrice: v.optional(v.number()),
    titleCompany: v.optional(
      v.object({
        name: v.optional(v.string()),
        phone: v.optional(v.string()),
        selectedBy: v.optional(v.string()),
      })
    ),
    earnestMoney: v.optional(
      v.object({
        amount: v.optional(v.number()),
        refundable: v.optional(v.boolean()),
        depositDays: v.optional(v.number()),
      })
    ),
    financingApprovalDays: v.optional(v.number()),
  })
    .index('by_tenant_filenumber', ['tenantId', 'fileNumber'])
    .index('by_tenant_status', ['tenantId', 'status'])
    .index('by_tenant_county', ['tenantId', 'countyId'])
    .index('by_tenant_openedAt', ['tenantId', 'openedAt'])
    .searchIndex('search_text', {
      searchField: 'searchText',
      filterFields: ['tenantId'],
    }),

  parties: defineTable({
    tenantId: v.id('tenants'),
    partyType: partyType,
    legalName: v.string(),
    dba: v.optional(v.string()),
    formationState: v.optional(v.string()),
    entitySubtype: v.optional(v.string()),
    einOrSsnToken: v.optional(v.string()),
  })
    .index('by_tenant_legalname', ['tenantId', 'legalName'])
    .searchIndex('search_legalname', {
      searchField: 'legalName',
      filterFields: ['tenantId'],
    }),

  fileParties: defineTable({
    tenantId: v.id('tenants'),
    fileId: v.id('files'),
    partyId: v.id('parties'),
    role: v.string(),
    capacity: v.optional(v.string()),
    ownershipPct: v.optional(v.number()),
  })
    .index('by_tenant_file', ['tenantId', 'fileId'])
    .index('by_tenant_party', ['tenantId', 'partyId']),

  documents: defineTable({
    tenantId: v.id('tenants'),
    fileId: v.optional(v.id('files')),
    docType: v.string(),
    title: v.optional(v.string()),
    // Denormalized title + docType for the cross-entity search palette.
    // Populated by files.uploadDocument and inboundEmail._ingestInbound.
    searchText: v.optional(v.string()),
    storageId: v.id('_storage'),
    contentType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    checksum: v.optional(v.string()),
    pageCount: v.optional(v.number()),
    ocrStatus: v.optional(v.string()),
    uploadedByMemberId: v.id('tenantMembers'),
    uploadedAt: v.number(),
  })
    .index('by_tenant_file', ['tenantId', 'fileId'])
    .index('by_tenant_uploadedAt', ['tenantId', 'uploadedAt'])
    .searchIndex('search_text', {
      searchField: 'searchText',
      filterFields: ['tenantId'],
    }),

  // ───── Sprint 4: extraction + reconciliation ──────────────────
  documentExtractions: defineTable({
    tenantId: v.id('tenants'),
    fileId: v.id('files'),
    documentId: v.id('documents'),
    status: v.union(
      v.literal('pending'),
      v.literal('running'),
      v.literal('succeeded'),
      v.literal('failed')
    ),
    payload: v.optional(v.any()),
    errorMessage: v.optional(v.string()),
    modelId: v.optional(v.string()),
    source: v.union(v.literal('claude'), v.literal('mock')),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index('by_tenant_file', ['tenantId', 'fileId'])
    .index('by_tenant_document', ['tenantId', 'documentId']),

  // Per-step audit trail for an in-flight extraction. Append-only — the
  // runner emits one row per phase boundary (and on warnings/errors) so
  // the UI can render a live "thinking trail" while a doc is being read,
  // and a permanent timeline after the fact. Distinct from the
  // documentExtractions row (which holds the final payload) so a noisy
  // run doesn't bloat the parent record.
  extractionEvents: defineTable({
    tenantId: v.id('tenants'),
    extractionId: v.id('documentExtractions'),
    fileId: v.id('files'),
    documentId: v.id('documents'),
    seq: v.number(),
    kind: v.union(
      v.literal('phase'),
      v.literal('observation'),
      v.literal('warning'),
      v.literal('error'),
      v.literal('done')
    ),
    label: v.string(),
    detail: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_tenant_extraction_seq', ['tenantId', 'extractionId', 'seq'])
    .index('by_tenant_file_time', ['tenantId', 'fileId', 'createdAt']),

  // Per-file-per-item human attestations for the Closing Day workflow.
  // Drives the checklist on /closing — items like "I've issued the CPL",
  // "Funds confirmed in escrow", "IDs verified" can't be derived from
  // extractions, so we record an explicit attestation. One row per
  // (file, item) combo: the index enforces idempotency client-side and
  // unattest hard-deletes.
  closingAttestations: defineTable({
    tenantId: v.id('tenants'),
    fileId: v.id('files'),
    item: v.string(),
    attestedByMemberId: v.id('tenantMembers'),
    attestedAt: v.number(),
    note: v.optional(v.string()),
  })
    .index('by_tenant_file', ['tenantId', 'fileId'])
    .index('by_tenant_file_item', ['tenantId', 'fileId', 'item']),

  reconciliationFindings: defineTable({
    tenantId: v.id('tenants'),
    fileId: v.id('files'),
    findingType: v.string(),
    severity: v.union(v.literal('info'), v.literal('warn'), v.literal('block')),
    message: v.string(),
    involvedDocumentIds: v.array(v.id('documents')),
    involvedFields: v.array(v.string()),
    rawDetail: v.any(),
    status: v.union(
      v.literal('open'),
      v.literal('acknowledged'),
      v.literal('resolved'),
      v.literal('dismissed')
    ),
    // Optional owner. Set via reconciliation.assignFinding. The My Queue
    // page surfaces every finding with assigneeMemberId === me; unowned
    // open blockers also surface in a "needs an owner" group.
    assigneeMemberId: v.optional(v.id('tenantMembers')),
    resolvedByMemberId: v.optional(v.id('tenantMembers')),
    resolvedAt: v.optional(v.number()),
    // When a processor closes a mismatch by picking which document is
    // authoritative, we record the chosen document and the value taken from it.
    // resolvedValue is a free-form snapshot (price, name string, etc.) — the
    // exact shape varies by findingType.
    resolvedDocumentId: v.optional(v.id('documents')),
    resolvedValue: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index('by_tenant_file', ['tenantId', 'fileId'])
    .index('by_tenant_file_status', ['tenantId', 'fileId', 'status'])
    .index('by_tenant_status', ['tenantId', 'status'])
    .index('by_tenant_assignee_status', [
      'tenantId',
      'assigneeMemberId',
      'status',
    ])
    .searchIndex('search_message', {
      searchField: 'message',
      filterFields: ['tenantId'],
    }),

  // Per-file internal notes. Distinct from extraction payloads (which
  // come from documents) so a processor's "called the seller, voicemail"
  // note doesn't pollute the structured ground-truth set. @-mentions
  // resolve to tenantMembers and fan out a notification.
  fileComments: defineTable({
    tenantId: v.id('tenants'),
    fileId: v.id('files'),
    authorMemberId: v.id('tenantMembers'),
    body: v.string(),
    mentionedMemberIds: v.array(v.id('tenantMembers')),
    createdAt: v.number(),
    editedAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
  })
    .index('by_tenant_file_time', ['tenantId', 'fileId', 'createdAt'])
    .index('by_tenant_author_time', [
      'tenantId',
      'authorMemberId',
      'createdAt',
    ]),

  // Member-scoped follow-ups: "remind me Tuesday morning to chase the
  // survey on file X." A scheduled action runs at dueAt and fires a
  // notification. Completed follow-ups stay around for the audit trail
  // until a tenant retention policy lands.
  fileFollowups: defineTable({
    tenantId: v.id('tenants'),
    fileId: v.id('files'),
    memberId: v.id('tenantMembers'),
    note: v.string(),
    dueAt: v.number(),
    createdByMemberId: v.id('tenantMembers'),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
    completedByMemberId: v.optional(v.id('tenantMembers')),
    notifiedAt: v.optional(v.number()),
  })
    .index('by_tenant_member_due', ['tenantId', 'memberId', 'dueAt'])
    .index('by_tenant_file', ['tenantId', 'fileId'])
    .index('by_due', ['dueAt']),

  // Per-member search history for the standalone /county-connect page.
  // Stores the full bundle so re-clicking a recent renders without a paid
  // ATTOM call. Capped per member by `recordSearch` (oldest beyond N
  // dropped). Tenant-scoped + member-scoped — a processor's history is
  // private to them within the tenant.
  countyConnectSearches: defineTable({
    tenantId: v.id('tenants'),
    memberId: v.id('tenantMembers'),
    query: v.string(),
    ownerName: v.union(v.string(), v.null()),
    fetchedAt: v.number(),
    provider: v.union(v.literal('attom'), v.literal('mock')),
    property: v.union(propertyProfileV, v.null()),
    documents: v.array(recordedDocumentV),
    tax: v.union(taxDataV, v.null()),
    // Untyped raw provider responses, kept per-endpoint for debugging only.
    // Never returned by the public query — inspect via the Convex dashboard
    // or an internal helper. Optional so historical rows remain valid.
    rawResponse: v.optional(
      v.object({
        property: v.optional(v.any()),
        documents: v.optional(v.any()),
        tax: v.optional(v.any()),
      })
    ),
  })
    .index('by_tenant_member_fetched', ['tenantId', 'memberId', 'fetchedAt'])
    .index('by_tenant_member_query', ['tenantId', 'memberId', 'query']),

  // County Connect snapshots — public-records lookup result cached per file.
  // One row per fetch; the most recent (by `fetchedAt`) is what reconciliation
  // and the file UI consume. Older rows kept for audit until a tenant-level
  // retention policy lands.
  propertySnapshots: defineTable({
    tenantId: v.id('tenants'),
    fileId: v.id('files'),
    provider: v.union(v.literal('attom'), v.literal('mock')),
    fetchedAt: v.number(),
    fetchedByMemberId: v.optional(v.id('tenantMembers')),
    queryAddress: propertyAddress,
    property: v.union(propertyProfileV, v.null()),
    documents: v.array(recordedDocumentV),
    tax: v.union(taxDataV, v.null()),
    status: v.union(
      v.literal('ok'),
      v.literal('partial'),
      v.literal('error')
    ),
    errorMessage: v.optional(v.string()),
    // Untyped raw provider responses, kept per-endpoint for debugging only.
    // See countyConnectSearches.rawResponse — same contract.
    rawResponse: v.optional(
      v.object({
        property: v.optional(v.any()),
        documents: v.optional(v.any()),
        tax: v.optional(v.any()),
      })
    ),
  })
    .index('by_tenant_file', ['tenantId', 'fileId'])
    .index('by_tenant_file_fetched', ['tenantId', 'fileId', 'fetchedAt']),

  webhookEndpoints: defineTable({
    tenantId: v.id('tenants'),
    url: v.string(),
    secret: v.string(),
    events: v.array(v.string()),
    enabled: v.boolean(),
    createdAt: v.number(),
  }).index('by_tenant', ['tenantId']),

  webhookDeliveries: defineTable({
    tenantId: v.id('tenants'),
    endpointId: v.id('webhookEndpoints'),
    event: v.string(),
    payload: v.any(),
    status: v.union(
      v.literal('pending'),
      v.literal('succeeded'),
      v.literal('failed')
    ),
    attemptCount: v.number(),
    lastAttemptAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_tenant_status', ['tenantId', 'status'])
    .index('by_tenant_endpoint', ['tenantId', 'endpointId']),

  // ───── Sprint 6: integrations ────────────────────────────────
  // One row per connected external system per tenant. `cursor` holds the
  // adapter's opaque incremental-sync cursor; `inboundSecret` is the HMAC
  // secret the external system uses to sign webhook callbacks back to us.
  // Plaintext credentials never live here — `credentialsToken` resolves to
  // an `npiSecrets` row via the existing tokenization path.
  integrations: defineTable({
    tenantId: v.id('tenants'),
    kind: v.union(
      v.literal('softpro_360'),
      v.literal('softpro_standard'),
      v.literal('qualia'),
      v.literal('resware'),
      v.literal('encompass'),
      v.literal('email_inbound'),
      v.literal('mock')
    ),
    name: v.string(),
    status: v.union(
      v.literal('active'),
      v.literal('disabled'),
      v.literal('error')
    ),
    config: v.any(),
    credentialsToken: v.optional(v.string()),
    inboundSecret: v.string(),
    cursor: v.optional(v.string()),
    lastSyncAt: v.optional(v.number()),
    lastSyncStatus: v.optional(
      v.union(v.literal('succeeded'), v.literal('failed'))
    ),
    lastError: v.optional(v.string()),
    filesSyncedTotal: v.number(),

    // Agent-mode fields. Populated by the customer-side agent (Sprint 6
    // Phase 2) for push-mode integrations like `softpro_standard`. Pull-mode
    // integrations leave these untouched.
    agentLastHeartbeatAt: v.optional(v.number()),
    agentVersion: v.optional(v.string()),
    agentHostname: v.optional(v.string()),
    // Opaque cursor the agent uses to track its own DB position (e.g. SQL
    // Server `rowversion`). Server-side we just store and echo it back.
    agentWatermark: v.optional(v.string()),

    createdAt: v.number(),
  })
    .index('by_tenant', ['tenantId'])
    .index('by_tenant_kind', ['tenantId', 'kind']),

  // One row per sync attempt. Drives the integration health card and acts as
  // the audit trail for "what did the last sync actually do."
  integrationSyncRuns: defineTable({
    tenantId: v.id('tenants'),
    integrationId: v.id('integrations'),
    trigger: v.union(
      v.literal('manual'),
      v.literal('webhook'),
      v.literal('cron')
    ),
    status: v.union(
      v.literal('running'),
      v.literal('succeeded'),
      v.literal('failed')
    ),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    filesProcessed: v.number(),
    filesUpserted: v.number(),
    errorCount: v.number(),
    errorSample: v.optional(v.string()),
  })
    .index('by_tenant_integration', ['tenantId', 'integrationId'])
    .index('by_tenant_startedAt', ['tenantId', 'startedAt']),

  // ───── Inbound email ingest ──────────────────────────────────
  // One row per email that arrives at a tenant's forwarding address. The
  // .eml (or provider JSON envelope) lives in `_storage` keyed by
  // `rawStorageId`; attachments that have been auto-attached to a file are
  // represented as `documents` rows whose ids are listed in
  // `attachmentDocumentIds`. Attachments on a `quarantined` row exist as
  // `documents` rows with `fileId` undefined until a processor routes them.
  //
  // Status flow:
  //   pending      – inserted by the inbound HTTP route, not yet classified.
  //   classifying  – the classifier action is mid-flight.
  //   auto_attached – classifier matched a file at high confidence and
  //                   created/linked attachments to it.
  //   quarantined  – no high-confidence match; awaits human triage.
  //   archived     – processor dismissed the row (no file action).
  //   spam         – processor flagged sender; future mail from this sender
  //                   skips classification (left as a follow-up).
  //   failed       – ingest threw; surfaced in the Mail UI for retry.
  inboundEmails: defineTable({
    tenantId: v.id('tenants'),
    integrationId: v.id('integrations'),
    // Provider's stable id (Postmark MessageID, SES messageId, etc.). Used
    // for dedup if the provider retries delivery.
    providerMessageId: v.string(),
    fromAddress: v.string(),
    fromName: v.optional(v.string()),
    toAddress: v.string(),
    subject: v.string(),
    bodyText: v.optional(v.string()),
    // Provider-supplied HTML body. Rendered in a sandboxed iframe in the
    // Mail detail sheet; never injected as raw markup. Some providers send
    // only HTML, some only text — both fields are optional and the UI
    // prefers HTML when present (with a "Show plain text" fallback).
    bodyHtml: v.optional(v.string()),
    receivedAt: v.number(),
    rawStorageId: v.optional(v.id('_storage')),
    status: v.union(
      v.literal('pending'),
      v.literal('classifying'),
      v.literal('auto_attached'),
      v.literal('quarantined'),
      v.literal('archived'),
      v.literal('spam'),
      v.literal('failed')
    ),
    matchedFileId: v.optional(v.id('files')),
    matchConfidence: v.optional(v.number()),
    matchReason: v.optional(v.string()),
    // Bounded by MAX_ATTACHMENTS_PER_EMAIL in inboundEmail.ts. A staff-style
    // closing package with 100 PDFs would exceed it; that's an outlier we
    // surface as `failed` rather than silently truncating.
    attachmentDocumentIds: v.array(v.id('documents')),
    attachmentCount: v.number(),
    classifiedAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    // Authenticity / spam scoring — see convex/lib/spamScore.ts. Score is
    // 0..100; tier is the bucket the score falls into. Signals are an
    // array of short labels explaining what fired so the UI can render
    // a why-list without re-running the scorer.
    spamScore: v.optional(v.number()),
    spamTier: v.optional(
      v.union(
        v.literal('clean'),
        v.literal('suspicious'),
        v.literal('high_risk')
      )
    ),
    spamSignals: v.optional(
      v.array(
        v.object({
          id: v.string(),
          label: v.string(),
          weight: v.number(),
        })
      )
    ),
    replyToAddress: v.optional(v.string()),
    spfResult: v.optional(v.string()),
    dkimResult: v.optional(v.string()),
    dmarcResult: v.optional(v.string()),
    // Claude-derived classification layered on top of the deterministic
    // file-number / address match. Populated by inboundEmailClassifier.run
    // shortly after _ingestInbound. Surfaces intent + reasons in the Mail
    // UI; can also escalate confidence above the AUTO_ATTACH threshold
    // when the model is sure and the deterministic path missed.
    classification: v.optional(
      v.object({
        intent: v.string(),
        confidence: v.number(),
        reasons: v.array(v.string()),
        suggestedFileId: v.optional(v.id('files')),
        suggestedFileNumber: v.optional(v.string()),
        classifiedAt: v.number(),
        modelId: v.optional(v.string()),
      })
    ),
    // Optional triage owner — set via inboundEmail.assignEmail. The My
    // Queue page surfaces emails with assigneeMemberId === me; unowned
    // quarantined emails surface in a separate "needs an owner" group.
    assigneeMemberId: v.optional(v.id('tenantMembers')),
  })
    .index('by_tenant_status_received', ['tenantId', 'status', 'receivedAt'])
    .index('by_tenant_received', ['tenantId', 'receivedAt'])
    .index('by_tenant_message', [
      'tenantId',
      'integrationId',
      'providerMessageId',
    ])
    .index('by_tenant_assignee_status', [
      'tenantId',
      'assigneeMemberId',
      'status',
    ])
    .searchIndex('search_subject', {
      searchField: 'subject',
      filterFields: ['tenantId'],
    }),

  // ───── Sprint 2: NPI tokenization ─────────────────────────────
  npiSecrets: defineTable({
    tenantId: v.id('tenants'),
    token: v.string(), // npi_tok_...
    ciphertext: v.bytes(),
    iv: v.bytes(),
    keyRef: v.string(), // KMS ARN, or "mock:<keyId>" for dev
    fieldKind: v.union(
      v.literal('ssn'),
      v.literal('ein'),
      v.literal('account'),
      v.literal('dob')
    ),
    erased: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index('by_tenant_token', ['tenantId', 'token'])
    .index('by_tenant_createdAt', ['tenantId', 'createdAt']),

  tenantCryptoKeys: defineTable({
    tenantId: v.id('tenants'),
    keyRef: v.string(), // matches npiSecrets.keyRef
    provider: v.union(v.literal('mock'), v.literal('aws-kms')),
    rawKey: v.optional(v.bytes()), // mock-only; for aws-kms this is null
    status: v.union(v.literal('active'), v.literal('destroyed')),
    createdAt: v.number(),
    destroyedAt: v.optional(v.number()),
  })
    .index('by_tenant_active', ['tenantId', 'status'])
    .index('by_tenant_keyRef', ['tenantId', 'keyRef']),

  // Short-lived, single-use credentials issued by an admin in the web UI to
  // bootstrap an agent install. The customer-side `agent install` command
  // POSTs the plaintext token to /integrations/agent/redeem; the server
  // hashes, looks up by `tokenHash`, marks `consumedAt`, and returns the
  // integrationId + inboundSecret. No long-lived secrets ever cross the
  // copy-paste boundary.
  agentInstallTokens: defineTable({
    tenantId: v.id('tenants'),
    integrationId: v.id('integrations'),
    // Hex-encoded SHA-256 of the plaintext token. Plaintext is shown to
    // the admin once (at generation time) and never stored.
    tokenHash: v.string(),
    // First 8 chars of the plaintext, surfaced in the admin UI so an admin
    // can identify a still-active token at a glance.
    prefix: v.string(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
    consumedFromIp: v.optional(v.string()),
    createdByMemberId: v.id('tenantMembers'),
    createdAt: v.number(),
  })
    .index('by_token_hash', ['tokenHash'])
    .index('by_tenant_integration', [
      'tenantId',
      'integrationId',
      'createdAt',
    ]),

  // Allowlist of users who can create organizations. The very first user to
  // sign up (via the user trigger) is auto-inserted here; everyone else must
  // be added explicitly. Non-admins are restricted to invitation-based
  // onboarding into existing orgs.
  systemAdmins: defineTable({
    betterAuthUserId: v.string(),
    addedAt: v.number(),
    addedBy: v.optional(v.string()), // betterAuthUserId of the granter, or "system"
  }).index('by_user', ['betterAuthUserId']),

  // Per-member notification feed. Drives the bell icon in the header.
  // Created opportunistically off audit events worth surfacing (extraction
  // succeeded/failed, reconciliation findings, file status changes, etc.).
  notifications: defineTable({
    tenantId: v.id('tenants'),
    memberId: v.id('tenantMembers'), // recipient
    kind: v.string(), // "extraction.succeeded", etc.
    title: v.string(),
    body: v.optional(v.string()),
    severity: v.optional(v.string()), // "info" | "warn" | "block" | "ok"
    fileId: v.optional(v.id('files')), // primary link target
    // Stable key used to collapse a noisy stream of related notifications
    // into a single row in the bell. Default policy: `${kind}:${fileId}`
    // when a fileId is present, otherwise the kind itself. Older rows
    // without a groupKey render as one-row groups.
    groupKey: v.optional(v.string()),
    actorMemberId: v.optional(v.id('tenantMembers')),
    actorType: v.optional(v.string()),
    occurredAt: v.number(),
    readAt: v.optional(v.number()),
  })
    .index('by_tenant_member_time', ['tenantId', 'memberId', 'occurredAt'])
    .index('by_tenant_member_unread', [
      'tenantId',
      'memberId',
      'readAt',
      'occurredAt',
    ]),
})
