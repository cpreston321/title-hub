# Title Operations Platform — Technical Design Document

**Status:** Draft v0.3
**Stack:** Convex (backend, database, files, scheduling) + Better Auth via `@convex-dev/better-auth` (identity, orgs, sessions, MFA) + TanStack Start v1 (full-stack React)
**Scope:** Phase 1 (multi-tenant foundation) and Phase 2 (state/county configuration framework), with the order-entry-integrity wedge as the first product surface.
**Audience:** Founding engineering team, technical advisors, future security/compliance reviewers.

---

## 1. Overview

### Problem
Title agencies operate on a fragmented stack — SoftPro, Qualia, ResWare, RamQuest, Gmail, county portals, e-recording vendors, lender portals — and absorb the cost of that fragmentation as re-entry, missed details, and tribal knowledge lock-in. The eight workstreams in the source deck (order entry, vesting, search/exam, exception triage, knowledge, scheduling, funding/fraud, recording/policy) are universal industry pain points.

### Goals (v1)
1. Multi-tenant SaaS that can safely host two pilot agencies plus a third reference customer by month 6.
2. A configuration framework where state and county rules live as **versioned data**, not code — so onboarding a new county is a data task, not an engineering project.
3. Ship the **order-entry-integrity** capability as the first revenue-bearing product surface (the wedge).
4. Operate within Convex's SOC 2 Type II + HIPAA posture, with a signed BAA, plus our own application-layer controls for NPI tokenization. Identity data stays inside the Convex compliance boundary (Better Auth, self-hosted via the Convex component) — no separate identity vendor in the BAA chain.
5. Integration adapters for at least SoftPro 360 and Encompass by pilot.

### Non-Goals (v1)
- Replacing production systems (SoftPro/Qualia stay; we sit alongside).
- Document assembly automation (Phase 5).
- Closing scheduling optimization (Phase 5).
- Direct e-recording submission (we generate the package; the agency or their existing vendor submits).
- Mobile native apps (responsive web only, served by TanStack Start).

### Why this stack
- **Convex** gives us reactive queries by default. The "central file visibility dashboard" from Phase 1 of the deck is a single `useQuery` away from being live across all collaborators — no websocket plumbing, no cache invalidation logic, no stale-while-revalidate gymnastics.
- **TanStack Start** is client-first, which matches our usage pattern (long-lived agency users on a dashboard) better than RSC-first frameworks. It also keeps the team in pure TypeScript end-to-end with the rest of the TanStack ecosystem (Query, Router, Form, Table).
- **Better Auth (via `@convex-dev/better-auth`)** runs as a Convex Component — auth tables, sessions, MFA, and organizations all live inside our Convex deployment. Self-hosted, no per-MAU pricing, identity data never leaves the compliance perimeter. The Organizations plugin maps cleanly to our tenant model.

The tradeoff: vendor coupling to Convex. Mitigation in §12.

---

## 2. System Architecture

```
                ┌────────────────────────────────────────────────┐
                │  Browser — TanStack Start (React, Vite, Nitro) │
                │  Routes • TanStack Query • Convex React client │
                │  Better Auth React client (sign-in, sessions)  │
                └────────────────────┬───────────────────────────┘
                                     │ WebSocket (live queries) + HTTPS
                                     │ Better Auth session → Convex JWT
                ┌────────────────────▼───────────────────────────┐
                │                    Convex                      │
                │                                                │
                │   queries/   mutations/   actions/   http/     │
                │   (read,     (write,      (network, (REST &    │
                │    live)      atomic)      LLM, OCR) webhooks) │
                │                                                │
                │   schema (TS) • indexes • search • files •     │
                │   scheduler • cron • components:               │
                │     • betterAuth (users, sessions, orgs, MFA)  │
                │     • workpool, workflow, rate-limiter,        │
                │       migrations                               │
                └────────────────────┬───────────────────────────┘
                                     │
                              ┌──────▼───────────────┐
                              │  External services   │
                              │  • SoftPro 360       │
                              │  • Qualia / ResWare  │
                              │  • Encompass         │
                              │  • AWS KMS (NPI)     │
                              │  • LLM (Anthropic)   │
                              │  • OCR (Textract /   │
                              │    Azure DI)         │
                              │  • Email (Resend)    │
                              │    for auth flows    │
                              └──────────────────────┘
```

The shape that matters: **Convex is the backend** (no separate API tier in v1), **TanStack Start is the application layer** (SSR for first paint, client-driven thereafter), and **external integrations live behind Convex actions** so retries, timeouts, and rate-limiting are uniform.

---

## 3. Multi-Tenancy & Auth Model

### Identity flow
1. User authenticates via Better Auth — email/password, magic link, or OAuth (Google, Microsoft for agency MS365 users). Better Auth runs as a Convex Component (`@convex-dev/better-auth`), so users, sessions, accounts, organizations, members, and invitations all live in our Convex deployment.
2. Better Auth issues a session, and the Convex bridge translates that into the auth context Convex's `ctx.auth.getUserIdentity()` reads. No external JWT issuer.
3. We use Better Auth's **Organizations plugin** for multi-tenancy. Each Better Auth organization corresponds 1:1 to a row in our application-side `tenants` table. The session carries an `activeOrganizationId` we use as the tenant key.
4. Every Convex query, mutation, and action begins with `requireTenant(ctx)`, which resolves the current Better Auth user, their active organization, and our application-side tenant + role.
5. **Auth triggers** (`onCreateUser`, `onCreateOrganization`, `onCreateMember`) keep our app-side `tenants` and `users` tables in sync with Better Auth's component-internal tables — provisioning a per-tenant KMS CMK on org creation, defaulting roles, etc.

### What lives where
- **Better Auth component (managed):** `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`, `twoFactor`, `passkey`. We don't author these — Better Auth's plugin schemas do.
- **Our application schema:** `tenants` (extends Better Auth orgs with plan/status/CMK), `users` (extends Better Auth users with role, NPI access flag, tenant linkage), and everything domain-specific.

This split means we get email verification, password reset, MFA enrollment, magic links, OAuth, and invitation flows for free, while keeping our domain model clean.

### Tenant isolation: enforced in every function
Convex has no row-level security. Isolation is the codebase's responsibility — which is why every read and write goes through a single helper, and there's no escape hatch.

```typescript
// convex/lib/tenant.ts
import { QueryCtx, MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { authComponent } from "../auth";

export type TenantContext = {
  userId: Id<"users">;
  tenantId: Id<"tenants">;
  betterAuthUserId: string;
  betterAuthOrgId: string;
  role: "owner" | "admin" | "processor" | "closer" | "reviewer" | "readonly";
};

export async function requireTenant(
  ctx: QueryCtx | MutationCtx,
): Promise<TenantContext> {
  // Better Auth: throws if not signed in or session is invalid
  const authUser = await authComponent.getAuthUser(ctx);

  // The Organizations plugin stores the active org on the session
  const session = await authComponent.getSession(ctx);
  const activeOrgId = session?.activeOrganizationId;
  if (!activeOrgId) throw new Error("NO_ACTIVE_TENANT");

  // Resolve our app-side tenant
  const tenant = await ctx.db
    .query("tenants")
    .withIndex("by_better_auth_org", (q) => q.eq("betterAuthOrgId", activeOrgId))
    .unique();
  if (!tenant) throw new Error("TENANT_NOT_PROVISIONED");
  if (tenant.status !== "active") throw new Error("TENANT_INACTIVE");

  // Resolve our app-side user
  const user = await ctx.db
    .query("users")
    .withIndex("by_better_auth_user", (q) =>
      q.eq("betterAuthUserId", authUser._id),
    )
    .unique();
  if (!user) throw new Error("USER_NOT_PROVISIONED");
  if (user.status !== "active") throw new Error("USER_INACTIVE");

  // Defense-in-depth: the user's tenant must match the session's active org
  if (user.tenantId !== tenant._id) throw new Error("TENANT_MISMATCH");

  return {
    userId: user._id,
    tenantId: tenant._id,
    betterAuthUserId: authUser._id,
    betterAuthOrgId: activeOrgId,
    role: user.role,
  };
}

export function requireRole(
  ctx: TenantContext,
  ...allowed: TenantContext["role"][]
) {
  if (!allowed.includes(ctx.role)) throw new Error("FORBIDDEN");
}
```

Every domain function uses it:

```typescript
// convex/files.ts
export const listOpenFiles = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, { status }) => {
    const tc = await requireTenant(ctx);
    const idx = ctx.db.query("files").withIndex("by_tenant_status", (q) =>
      status
        ? q.eq("tenantId", tc.tenantId).eq("status", status)
        : q.eq("tenantId", tc.tenantId),
    );
    return await idx.take(200);
  },
});
```

**Lint rule:** A custom ESLint rule (or simple grep in CI) fails the build if any file under `convex/` defines a `query`/`mutation`/`action` and does not call `requireTenant` or explicitly opt out via a comment marker for whitelisted public functions (e.g., the public health check). This is the single most important guardrail in the codebase.

### Better Auth setup (the wiring)

```typescript
// convex/auth.ts
import {
  createClient,
  type GenericCtx,
} from "@convex-dev/better-auth";
import { components } from "./_generated/api";
import { betterAuth } from "better-auth";
import { organization, twoFactor, magicLink } from "better-auth/plugins";
import { sendEmailVerification, sendInvite, sendOtp } from "./email";
import type { DataModel } from "./_generated/dataModel";

export const authComponent = createClient<DataModel>(components.betterAuth, {
  triggers: {
    user: {
      onCreate: async (ctx, authUser) => {
        // We don't auto-create app-side users here; users are provisioned
        // by accepting an invitation, which creates the app-side row.
      },
    },
    organization: {
      onCreate: async (ctx, org) => {
        // Provision per-tenant KMS CMK and create our app-side tenant row
        await ctx.runAction(internal.tenants.provisionFromBetterAuth, {
          betterAuthOrgId: org.id,
          slug: org.slug,
          legalName: org.name,
        });
      },
    },
    member: {
      onCreate: async (ctx, member) => {
        // When a user accepts an invitation, create the app-side user row
        await ctx.runMutation(internal.users.provisionFromMember, {
          betterAuthUserId: member.userId,
          betterAuthOrgId: member.organizationId,
          memberRole: member.role,
        });
      },
    },
  },
});

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    baseURL: process.env.SITE_URL!,
    database: authComponent.adapter(ctx),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => {/* ... */},
    },
    emailVerification: {
      sendVerificationEmail: sendEmailVerification,
    },
    plugins: [
      organization({
        sendInvitationEmail: sendInvite,
      }),
      twoFactor({
        otpOptions: { sendOTP: sendOtp },
      }),
      magicLink({
        sendMagicLink: async ({ email, url }) => {/* ... */},
      }),
    ],
  });
```

The `triggers` block is the seam where Better Auth's lifecycle events provision our app-side `tenants` and `users` rows — including the per-tenant KMS key in §4. Triggers run inside Convex transactions, so this stays consistent.

### Indexing every tenant-scoped table
Every domain table is indexed leading with `tenantId` so reads are fast within a tenant and never scan across tenants. Enforced by code review and by a schema-validation script in CI that walks `defineSchema` and asserts every non-global table has at least one index starting with `tenantId`.

### Roles
- **owner** — billing, user management, integrations
- **admin** — same as owner minus billing
- **processor** — file CRUD, vesting reconciliation, exceptions
- **closer** — read files, manage scheduling
- **reviewer** — read-only with elevated NPI access
- **readonly** — dashboards only, no NPI

NPI access is gated by a separate flag (`canViewNpi: boolean`) on the user record, independent of role, and viewing NPI emits an audit event (§9).

---

## 4. Sensitive Data (NPI/PII) Handling

Title work involves SSNs, EINs, account numbers, and dates of birth. Convex encrypts data at rest and in transit and is HIPAA-compliant — but we still want defense in depth, customer-managed key rotation, and the ability to cryptographically erase a tenant on offboarding. So we tokenize the highest-sensitivity fields outside Convex.

### Pattern: opaque tokens in Convex, ciphertext in KMS-backed store
1. Application sends plaintext SSN/EIN over TLS to a Convex `httpAction` (`/api/v1/secrets/issue`).
2. The action calls AWS KMS via the AWS SDK, encrypting the value with a per-tenant Customer Master Key (CMK).
3. The ciphertext is stored in the `npiSecrets` table; the action returns an opaque token: `npi_tok_01HX...`.
4. The token, not the plaintext, lives on `parties.einOrSsnToken` (and similar fields).
5. To read the plaintext (rare — usually only at recording or final policy time), an action calls KMS to decrypt; the read is logged with elevated audit detail (who, when, which file, why).

```typescript
// convex/schema.ts (excerpt)
npiSecrets: defineTable({
  tenantId: v.id("tenants"),
  token: v.string(),                    // npi_tok_...
  ciphertext: v.bytes(),                // KMS-encrypted blob
  kmsKeyArn: v.string(),                // per-tenant CMK
  fieldKind: v.union(
    v.literal("ssn"),
    v.literal("ein"),
    v.literal("account"),
    v.literal("dob"),
  ),
  createdAt: v.number(),
})
  .index("by_token", ["token"])
  .index("by_tenant", ["tenantId"]),
```

**Tenant offboarding** = scheduling deletion of the per-tenant CMK. The ciphertext rows become permanently undecryptable; cryptographic erasure satisfies most contractual deletion clauses without needing to chase rows.

Lower-sensitivity PII (names, addresses, phone) lives in normal Convex tables, protected by Convex's at-rest encryption and our auth checks.

---

## 5. Core Data Model

Convex schema in TypeScript. Indexes shown selectively for clarity.

```typescript
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // ─── Tenancy & identity ──────────────────────────────────────────
  // Note: Better Auth manages its own user/session/account/organization/
  // member/invitation/twoFactor tables inside the betterAuth component.
  // The tables below are *our application-side extensions* — linked to
  // Better Auth records by id and kept in sync via auth triggers.

  tenants: defineTable({
    slug: v.string(),
    legalName: v.string(),
    betterAuthOrgId: v.string(),            // Better Auth organization.id
    status: v.union(
      v.literal("trial"), v.literal("active"),
      v.literal("suspended"), v.literal("churned"),
    ),
    plan: v.string(),
    primaryState: v.optional(v.string()),
    npiKmsKeyArn: v.string(),               // per-tenant CMK
    createdAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_better_auth_org", ["betterAuthOrgId"]),

  users: defineTable({
    tenantId: v.id("tenants"),
    betterAuthUserId: v.string(),           // Better Auth user.id
    email: v.string(),                      // denormalized for fast lookup
    role: v.union(
      v.literal("owner"), v.literal("admin"), v.literal("processor"),
      v.literal("closer"), v.literal("reviewer"), v.literal("readonly"),
    ),
    canViewNpi: v.boolean(),
    status: v.union(v.literal("active"), v.literal("suspended")),
    lastLoginAt: v.optional(v.number()),
  })
    .index("by_better_auth_user", ["betterAuthUserId"])
    .index("by_tenant_email", ["tenantId", "email"]),

  apiKeys: defineTable({
    tenantId: v.id("tenants"),
    name: v.string(),
    prefix: v.string(),                     // "tk_live_xxxx" displayable hint
    keyHash: v.string(),                    // argon2id of full key
    scopes: v.array(v.string()),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_tenant", ["tenantId"])
    .index("by_prefix", ["prefix"]),

  // ─── Files, parties, vesting, exceptions ─────────────────────────
  files: defineTable({
    tenantId: v.id("tenants"),
    fileNumber: v.string(),
    externalRefs: v.object({
      softproId: v.optional(v.string()),
      qualiaId: v.optional(v.string()),
      reswareId: v.optional(v.string()),
    }),
    stateCode: v.string(),                  // "IN", "OH", ...
    countyId: v.id("counties"),
    transactionType: v.string(),            // "purchase","refi","commercial","reo"
    underwriterId: v.optional(v.id("underwriters")),
    status: v.string(),                     // opened|in_exam|cleared|closing|funded|recorded|policied|cancelled
    propertyApn: v.optional(v.string()),
    propertyAddress: v.optional(v.object({
      line1: v.string(), line2: v.optional(v.string()),
      city: v.string(), state: v.string(), zip: v.string(),
    })),
    openedAt: v.number(),
    targetCloseDate: v.optional(v.number()),
    closedAt: v.optional(v.number()),
  })
    .index("by_tenant_filenumber", ["tenantId", "fileNumber"])
    .index("by_tenant_status", ["tenantId", "status"])
    .index("by_tenant_county", ["tenantId", "countyId"])
    .searchIndex("search_files", {
      searchField: "fileNumber",
      filterFields: ["tenantId", "status"],
    }),

  parties: defineTable({
    tenantId: v.id("tenants"),
    partyType: v.union(
      v.literal("person"), v.literal("entity"),
      v.literal("trust"), v.literal("estate"),
    ),
    legalName: v.string(),
    dba: v.optional(v.string()),
    formationState: v.optional(v.string()),
    entitySubtype: v.optional(v.string()),  // "llc","corp","irrevocable_trust",...
    einOrSsnToken: v.optional(v.string()),  // -> npiSecrets
  }).index("by_tenant_legalname", ["tenantId", "legalName"]),

  fileParties: defineTable({
    tenantId: v.id("tenants"),
    fileId: v.id("files"),
    partyId: v.id("parties"),
    role: v.string(),                       // buyer|seller|lender|borrower|trustee|signer
    capacity: v.optional(v.string()),
    ownershipPct: v.optional(v.number()),
  })
    .index("by_file", ["fileId"])
    .index("by_tenant_party", ["tenantId", "partyId"]),

  vestingRecords: defineTable({
    tenantId: v.id("tenants"),
    fileId: v.id("files"),
    source: v.string(),                     // buyer_form|purchase_agreement|lender_doc|current_vesting|manual
    sourceDocId: v.optional(v.id("documents")),
    rawText: v.string(),
    normalizedPartyId: v.optional(v.id("parties")),
    normalizedCapacity: v.optional(v.string()),
    confidence: v.optional(v.number()),
    extractedAt: v.number(),
  }).index("by_file", ["fileId"]),

  reconciliationFindings: defineTable({
    tenantId: v.id("tenants"),
    fileId: v.id("files"),
    findingType: v.string(),                // name_mismatch|capacity_unclear|missing_signer|ein_missing
    severity: v.union(v.literal("info"), v.literal("warn"), v.literal("block")),
    involvedRecords: v.any(),               // structured detail
    status: v.union(
      v.literal("open"), v.literal("acknowledged"),
      v.literal("resolved"), v.literal("dismissed"),
    ),
    resolvedBy: v.optional(v.id("users")),
    resolvedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_file", ["fileId"])
    .index("by_tenant_status", ["tenantId", "status"]),

  exceptions: defineTable({
    tenantId: v.id("tenants"),
    fileId: v.id("files"),
    exceptionType: v.string(),              // judgment|lien|mortgage|heloc|poa|bankruptcy|easement
    classification: v.optional(v.string()), // true_match|common_name_false_positive|requires_review
    schedule: v.optional(v.string()),       // B-I | B-II
    rawPayload: v.any(),
    clearedAt: v.optional(v.number()),
    clearedBy: v.optional(v.id("users")),
  }).index("by_file", ["fileId"]),

  documents: defineTable({
    tenantId: v.id("tenants"),
    fileId: v.optional(v.id("files")),
    docType: v.string(),
    storageId: v.id("_storage"),            // Convex file storage
    checksum: v.string(),
    pageCount: v.optional(v.number()),
    ocrStatus: v.optional(v.string()),
    uploadedBy: v.id("users"),
    uploadedAt: v.number(),
  }).index("by_file", ["fileId"]),

  // ─── Audit ───────────────────────────────────────────────────────
  auditEvents: defineTable({
    tenantId: v.id("tenants"),
    actorId: v.optional(v.id("users")),
    actorType: v.string(),                  // user | api_key | system | webhook
    action: v.string(),                     // file.created | npi.viewed | integration.synced
    resourceType: v.string(),
    resourceId: v.string(),
    metadata: v.any(),
    ipAddress: v.optional(v.string()),
    occurredAt: v.number(),
  })
    .index("by_tenant_time", ["tenantId", "occurredAt"])
    .index("by_resource", ["resourceType", "resourceId"]),
});
```

A nightly cron mirrors `auditEvents` to an S3 bucket in a separate AWS account with object-lock enabled, satisfying the "auditor will ask for immutable logs" requirement.

---

## 6. State/County Configuration Framework

This is the part that determines whether you can sell to customer #20 without rewriting code. The schema is global (not tenant-scoped) — it's our IP, shared across all tenants, with effective-dated versioning.

```typescript
// Global lookups (no tenantId)
states: defineTable({
  code: v.string(),                       // "IN"
  name: v.string(),
  lienPriorityRules: v.any(),
  witnessRequired: v.boolean(),
  homesteadRules: v.optional(v.any()),
}).index("by_code", ["code"]),

counties: defineTable({
  fipsCode: v.string(),                   // "18097" — Marion County, IN
  stateCode: v.string(),
  name: v.string(),
  recordingOffice: v.string(),
  eRecordingVendors: v.array(v.string()), // ["simplifile","csc","epn"]
  timezone: v.string(),
})
  .index("by_fips", ["fipsCode"])
  .index("by_state", ["stateCode"]),

countyRecordingRules: defineTable({
  countyId: v.id("counties"),
  docType: v.string(),                    // "deed", "mortgage", "release", ...
  rules: v.object({
    pageSize: v.optional(v.string()),
    margins: v.optional(v.object({
      top: v.number(), bottom: v.number(),
      left: v.number(), right: v.number(),
    })),
    requiredExhibits: v.array(v.string()),
    feeSchedule: v.any(),
    signaturePageRequirements: v.any(),
    notaryRequirements: v.any(),
  }),
  effectiveFrom: v.number(),
  effectiveTo: v.optional(v.number()),
  version: v.number(),
  authoredBy: v.id("users"),              // platform admin
  createdAt: v.number(),
})
  .index("by_county_doctype_effective",
         ["countyId", "docType", "effectiveFrom"]),

underwriters: defineTable({
  code: v.string(),                       // "FATIC","STC","OR","FNF","WFG","TRG"
  name: v.string(),
}),

underwriterEndorsementCodes: defineTable({
  underwriterId: v.id("underwriters"),
  stateCode: v.string(),
  endorsementCode: v.string(),
  description: v.string(),
  premiumRule: v.any(),
}).index("by_underwriter_state", ["underwriterId", "stateCode"]),

transactionTypes: defineTable({
  code: v.string(),                       // "purchase","refi","commercial","reo"
  name: v.string(),
  requiredDocs: v.array(v.string()),
}).index("by_code", ["code"]),
```

### Rule resolution
A pure helper resolves the active rule set for a given file at a given moment:

```typescript
export async function resolveRecordingRules(
  ctx: QueryCtx,
  countyId: Id<"counties">,
  docType: string,
  asOf: number,
) {
  const rule = await ctx.db
    .query("countyRecordingRules")
    .withIndex("by_county_doctype_effective", (q) =>
      q.eq("countyId", countyId).eq("docType", docType).lte("effectiveFrom", asOf),
    )
    .order("desc")
    .first();

  if (!rule) throw new Error(`No rules for ${countyId}/${docType} at ${asOf}`);
  if (rule.effectiveTo && rule.effectiveTo < asOf) {
    throw new Error("Rule expired with no successor");
  }
  return rule;
}
```

Files in flight always resolve against the rule effective at the file's `openedAt`, so a county fee schedule change mid-transaction doesn't retroactively break a closing.

### Seeding strategy
1. Day 1: seed `states` (50) and `counties` (~3,143 from Census FIPS) with name + state + timezone only.
2. As each state goes GA, fill in `countyRecordingRules` for its counties — content work, often done by a paralegal or curated by partner underwriters.
3. Build a small admin UI (`/admin/rules`) where platform admins propose, version, and publish rule changes. Use `@convex-dev/workflow` to model the propose → review → publish flow.

---

## 7. API Surface

Three audiences, three flavors:

### A. Internal — TanStack Start app talking to Convex
The app uses the Convex React client directly. No REST in between.

```tsx
// app/routes/files.$fileId.tsx
import { useQuery } from "convex/react";
import { api } from "convex/_generated/api";

export default function FileDetail() {
  const { fileId } = Route.useParams();
  const file = useQuery(api.files.getFile, { fileId });
  const findings = useQuery(api.reconciliation.listFindings, { fileId });
  // file and findings update live as anyone touches the file
}
```

### B. External — REST API for customer integrations
Convex `httpAction` exposes a versioned REST surface. Auth is by API key (Bearer); the key prefix is looked up, the key is verified, and we synthesize a tenant context.

```typescript
// convex/http.ts (excerpt)
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

const http = httpRouter();

http.route({
  path: "/api/v1/files",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const tc = await requireTenantFromApiKey(ctx, req);
    const body = await req.json();
    const fileId = await ctx.runMutation(internal.files.createFromApi, {
      tenantId: tc.tenantId,
      payload: body,
    });
    return new Response(JSON.stringify({ id: fileId }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
```

**v1 endpoints (curated):**

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/files` | Create a file |
| GET | `/api/v1/files/{id}` | Get file with parties, vesting, exceptions |
| PATCH | `/api/v1/files/{id}` | Update status, dates, refs |
| POST | `/api/v1/files/{id}/parties` | Add a party |
| POST | `/api/v1/files/{id}/documents` | Upload via signed URL |
| POST | `/api/v1/files/{id}/vesting/reconcile` | Trigger reconciliation |
| GET | `/api/v1/files/{id}/findings` | List reconciliation findings |
| GET | `/api/v1/files/{id}/exceptions` | List title exceptions |
| GET | `/api/v1/counties/{fips}/rules` | Resolved rules for a county/doc type |
| POST | `/api/v1/integrations/softpro/sync` | Force a sync (testing) |
| GET | `/api/v1/audit-events` | Tenant's own audit log (paginated) |

### C. Webhooks
**Inbound** (e.g., SoftPro pushes file updates to us): another `httpAction`, with HMAC-SHA256 verification using a per-integration secret, replay protection by timestamp + nonce.

**Outbound** (we notify the customer): an internal action `dispatchWebhook` that signs the payload, retries with exponential backoff, and records every attempt in `webhookDeliveries`. Use the `@convex-dev/workpool` component to bound concurrency and avoid runaway retries.

Outbound event types for v1:
- `file.created`, `file.status_changed`, `file.closed`
- `vesting.mismatch_detected`, `vesting.reconciled`
- `finding.created`, `finding.resolved`
- `exception.classified`, `exception.cleared`
- `integration.sync_failed`

### Idempotency
For external `POST` operations, accept an `Idempotency-Key` header. Store keyed responses in an `idempotencyKeys` table (with TTL via cron) and return the cached response on replay.

---

## 8. Integration Layer

Every external system is an **adapter**: a TypeScript module under `convex/integrations/<name>/` exposing a uniform interface.

```typescript
// convex/integrations/types.ts
export interface FileSnapshot {
  externalId: string;
  fileNumber: string;
  status: string;
  parties: Array<{ role: string; legalName: string; ein?: string }>;
  // ... normalized shape
}

export interface Adapter {
  name: "softpro" | "qualia" | "resware" | "encompass";
  testConnection(creds: unknown): Promise<{ ok: boolean; detail?: string }>;
  fetchFile(creds: unknown, externalId: string): Promise<FileSnapshot>;
  listChangedSince(creds: unknown, since: number): Promise<string[]>;
  pushUpdate?(creds: unknown, snapshot: FileSnapshot): Promise<void>;
}
```

Adapters are invoked from Convex `action`s (which can do network I/O, unlike queries/mutations). Long syncs use `@convex-dev/workpool` for bounded parallelism, and `@convex-dev/workflow` for stateful resumable jobs.

```typescript
// convex/integrations/softpro/sync.ts
export const fullSync = internalAction({
  args: { integrationId: v.id("integrations"), since: v.number() },
  handler: async (ctx, { integrationId, since }) => {
    const creds = await ctx.runQuery(internal.integrations.getCreds, {
      integrationId,
    });
    const ids = await softproAdapter.listChangedSince(creds, since);
    for (const externalId of ids) {
      await workpool.enqueue(ctx, internal.integrations.softpro.syncOne, {
        integrationId, externalId,
      });
    }
  },
});
```

**Adapter priority for v1:** SoftPro 360 (largest install base) and Encompass (lender side, inbound CD/loan data). Qualia and ResWare adapters land in v1.1.

**Credentials handling:** integration credentials (OAuth tokens, API keys for third-party systems) go through the same NPI tokenization path — never stored in plaintext in Convex tables.

---

## 9. Compliance & Audit

| Area | Approach |
|---|---|
| SOC 2 | Inherit Convex's SOC 2 Type II posture; layer our own controls (access reviews, change management, incident response runbooks). Plan our own SOC 2 Type II audit window starting month 9, completing month 18. |
| HIPAA | BAA with Convex executed before pilot. Treat all customer data as if it could be ePHI for control purposes — agency staff sometimes handle estate files involving health-related decedent context. |
| GLBA / NPI safeguards | Map controls to FTC Safeguards Rule (16 CFR 314): access controls, encryption, MFA, monitoring, incident response, vendor management. |
| ALTA Best Practices | Pillar-by-pillar control mapping: licensing, escrow controls, NPI privacy, settlement processes, policy production, consumer complaint procedures, insurance. Map our features to Pillars 3 (privacy/security) and 5 (policy production) explicitly. |
| Audit logging | `auditEvents` table; every state-change mutation writes one. NPI reads write elevated events. Nightly export to object-locked S3 in separate AWS account. 7-year retention. |
| Backup / DR | Convex provides PITR; we additionally export critical tables nightly to S3 for tenant-recoverable backups. RTO target: 4 hours. RPO target: 15 minutes. |
| Tenant offboarding | Cryptographic erasure of NPI (delete per-tenant CMK), then standard data export + deletion within 30 days of contract end. |

---

## 10. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Backend / DB | Convex | Reactive queries, integrated auth/files/scheduler/search, SOC 2 + HIPAA, no infra to manage |
| Convex components | `workpool`, `workflow`, `rate-limiter`, `migrations`, `aggregate` | Solve the long-running / reliable background problems we'd otherwise build |
| Frontend framework | TanStack Start v1 | Type-safe end-to-end, client-first matches our usage, deploy-anywhere via Nitro |
| Routing / data | TanStack Router + TanStack Query (for non-Convex data) | Already part of Start |
| Forms | TanStack Form | Type-safe, integrates with Convex mutations |
| Tables | TanStack Table | Headless, fits the file-list + reconciliation queue UIs |
| UI primitives | shadcn/ui + Tailwind | Customizable, no design lock-in, well-trodden with Start |
| Identity | Better Auth via `@convex-dev/better-auth` | Self-hosted in Convex; orgs plugin = tenants; email/password, OAuth, magic link, 2FA, passkeys; no per-MAU cost; identity data inside SOC 2/HIPAA boundary. SSO/SAML available via plugin when enterprise customers require it. |
| Transactional email (auth flows) | Resend | Verification, password reset, invitations, OTP — driven by Better Auth callbacks |
| Sensitive data | AWS KMS (per-tenant CMK) + Convex `httpAction` token issuer | Defense in depth beyond Convex's at-rest encryption; cryptographic erasure on offboarding |
| OCR | AWS Textract (forms) or Azure Document Intelligence | Mature for legal-doc layouts |
| LLM | Anthropic Claude | Strongest at structured extraction + reasoning over messy legal text |
| Hosting | TanStack Start on Cloudflare Workers (or Netlify) | Vite-native, low latency; Convex is hosted by Convex |
| Observability | Sentry (client + Convex actions), Convex dashboard, Axiom or Datadog for log aggregation | Sentry has a first-class Convex integration |
| IaC | Terraform for AWS (KMS, S3 audit bucket, IAM); `convex deploy` for Convex | Two clouds, two tools, both declarative |
| CI/CD | GitHub Actions: lint, typecheck, schema-isolation check, Convex preview deploy on PR, prod deploy on tag |   |

---

## 11. Sprint Plan (Sprint 0 → Pilot)

Two-week sprints. Calendar assumes one full-stack engineer + one founding engineer + part-time design. Adjust as headcount changes.

### Sprint 0 — Foundation (Weeks 1–2)
**Goal:** Repos, environments, and the tenant primitive exist.
- TanStack Start app scaffolded; routing skeleton (`/`, `/sign-in`, `/sign-up`, `/files`, `/admin`).
- Convex project; `convex/schema.ts` with `tenants`, `users`, `apiKeys`, `auditEvents`.
- Install `@convex-dev/better-auth` component; configure `convex/auth.ts` with email/password, OAuth (Google + Microsoft), magic link, 2FA, and the Organizations plugin.
- Better Auth React client wired into TanStack Start; sign-in/sign-up routes built against `authClient`.
- Auth triggers: `organization.onCreate` provisions an app-side `tenants` row + per-tenant KMS CMK; `member.onCreate` provisions an app-side `users` row.
- `requireTenant` helper (per §3); first integration test that asserts cross-tenant access throws.
- Resend integration for transactional emails (verification, invites, OTP).
- CI: lint, typecheck, the schema-isolation check, `convex deploy --preview`.
- AWS account structure (prod, staging, audit-archive); KMS CMK creation flow.

**Exit:** A real user can sign up, create an organization, invite a teammate, hit a Convex query that returns only their tenant's data, and we can prove cross-tenant isolation with a test that swaps active orgs and gets `FORBIDDEN`.

### Sprint 1 — Files + audit (Weeks 3–4)
**Goal:** Core domain model is live.
- `files`, `parties`, `fileParties`, `documents` tables and CRUD.
- Convex file storage wired up; document upload via signed URL.
- `auditEvents` mutation hook on every write; first audit-log viewer route.
- File list + file detail routes in TanStack Start, using `useQuery`.

**Exit:** A processor can create a file, attach a party, upload a document, and see the audit trail. Two browsers see updates live.

### Sprint 2 — NPI tokenization (Weeks 5–6)
**Goal:** SSN/EIN never live in Convex.
- `npiSecrets` table + `httpAction` issuer (KMS encrypt).
- `secrets.reveal` action with elevated audit logging.
- `canViewNpi` flag on `users`; UI gating.
- Per-tenant CMK provisioning runs on `tenants.create`.
- Tenant deletion runbook + cryptographic erasure script.

**Exit:** Tabletop exercise — simulate a tenant offboarding; prove all NPI for that tenant is unrecoverable.

### Sprint 3 — Configuration framework v1 (Weeks 7–8)
**Goal:** State / county / underwriter / transaction-type registries exist; rules are versioned.
- Schema for `states`, `counties`, `countyRecordingRules`, `underwriters`, `transactionTypes`.
- Seeder that loads all 50 states + ~3,143 counties from FIPS data.
- `resolveRecordingRules` helper.
- Admin UI for proposing/publishing rule versions (`/admin/rules`).
- Seed pilot states' rules (Indiana counties for the launch agencies).

**Exit:** Opening a file in Marion County, IN, resolves a real rule set; opening a file in a county with no rules surfaces a clear "rules not configured" message instead of silently failing.

### Sprint 4 — Order entry data integrity (the wedge) (Weeks 9–10)
**Goal:** First revenue-bearing capability in customers' hands.
- Source document upload + parsing pipeline (action → Textract → Claude normalization).
- Required-fields engine driven by `transactionType` + `countyRecordingRules`.
- Cross-document conflict detection (compare extracted fields across docs on the same file).
- `reconciliationFindings` records; UI queue grouped by file.
- First outbound webhook events.

**Exit:** A processor opens a file, drops in a purchase agreement + lender instructions + buyer form, and sees a list of mismatches and missing fields within 60 seconds — including at least one finding that catches an error a human would miss.

### Sprint 5 — Vesting + authority reconciliation (Weeks 11–12)
**Goal:** The second-most-painful pain point is solved.
- Legal name normalization (entity types, suffix handling, joint vesting parsing).
- Capacity flagging (trust, LLC, estate, POA, decedent).
- Vesting reconciliation queue UI.
- Resolution actions (acknowledge / dismiss / curative).

**Exit:** Replaying 20 historical files from the pilot agency's archive surfaces the same vesting issues their senior staff manually caught — plus at least two they missed.

### Sprint 6 — Integration foundation (Weeks 13–14)
**Goal:** We sit alongside SoftPro instead of asking customers to abandon it.
- Adapter framework + the `Adapter` interface.
- SoftPro 360 adapter: `testConnection`, `listChangedSince`, `fetchFile`.
- Workpool-bounded sync action; `integrations` + `webhookDeliveries` tables.
- Encompass inbound for lender data.
- Integration health dashboard (sync lag, error rate, last successful run).

**Exit:** A SoftPro file created in the agency's environment appears in our dashboard within 5 minutes, with parties and documents synced.

### Sprint 7 — Knowledge center scaffolding (Weeks 15–16)
**Goal:** A place for Jim/Caryn knowledge to live, structured.
- `knowledgeArticles`, `knowledgeVersions`, decision-tree rendering.
- Tagging by state, county, transaction type, exception type.
- Convex search index for full-text.
- Per-tenant scope + a path to shared/community packs (read-only for v1).
- Embed: surface relevant articles inline on the file detail view based on tags + active findings.

**Exit:** Pilot agencies can author and search 20+ articles; the file view recommends articles based on the file's findings.

### Sprint 8 — Compliance hardening + pilot prep (Weeks 17–18)
**Goal:** Pilot-ready.
- SOC 2 control evidence collection running automatically.
- Penetration test scheduled and remediations from it landed.
- DPA + BAA templates finalized; subprocessor list published.
- Pilot onboarding flow (org provisioning, integration setup, sample data).
- Customer-visible status page.
- Demo data seeding for sales conversations.

**Exit:** Easy Title and Quality Title go live in production. Third pilot agency signed for month 6.

---

## 12. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Convex vendor lock-in | Medium | High | Keep domain logic in pure-TS modules tested independently of Convex `ctx`; export critical data nightly to S3; document a migration path to Postgres + adapter layer if needed (probably 6–10 weeks at the size we'd attempt it). |
| `@convex-dev/better-auth` is alpha | Medium | Medium | Pin to specific version; track upstream changelog and Discord; keep the Better Auth surface narrow (use the documented APIs only, no internal access); the underlying Better Auth library is stable — only the Convex bridge is alpha, so worst case is a refactor of the auth adapter, not a re-platform. |
| Convex action timeouts on large SoftPro syncs | Medium | Medium | Workpool component for chunking; never run a multi-hour sync as one action. Workflow component for resumable orchestration. |
| Convex document size limits (~1 MB) on big legal docs | Medium | Low | Documents always live in `_storage`, never inline. Extracted structured data stays small. |
| Missed tenant isolation in a single function | Low | Critical | The schema-isolation lint check + `requireTenant` guardrail + integration tests that swap identities; quarterly red-team. |
| County rule data quality | High | Medium | Pair with a paralegal contractor; require effective dating + reviewer signoff before publish; track rule-change notifications via state title-association feeds. |
| Integration breakage from SoftPro/Qualia API changes | Medium | Medium | Synthetic integration tests run hourly against a sandbox tenant; alerting on first failure. |
| LLM extraction errors on legal text | Medium | High | Confidence thresholds; never auto-resolve high-severity findings; show source text alongside extraction; human-in-the-loop on first 90 days for every tenant. |

---

## 13. Open Questions

1. **State launch order.** Which 3–5 states do we commit to in v1? Indiana (pilot home) is obvious; pairing with a high-volume state (TX, FL) accelerates the underwriter-partnership conversation but multiplies content work.
2. **Underwriter partnership.** Is a co-marketing or technology-partner deal with a single underwriter (TRG, First American) realistic in the first 6 months? If yes, it should reshape the integration and policy-output priority.
3. **Pricing instrumentation.** Per-file billing requires a meter from day one. Where does the meter sit — `auditEvents`, a dedicated `usageEvents` table, or Stripe metering with Convex pushing events? (Recommendation: `usageEvents` table + Stripe meter, but worth a 30-minute decision conversation.)
4. **Knowledge center community packs.** Do we maintain a curated content layer ourselves, or only enable customer-to-customer sharing? The first creates a moat and a content cost; the second creates a network-effect-by-association.
5. **Data residency.** Convex hosts in AWS US regions. Any Canadian customer in scope for v1? If yes, we're either waiting on Convex regional support or adding a separate stack — material decision, worth surfacing early.
6. **Self-hosted vs Cloud Convex for largest customers.** Convex offers self-hosting; some large agencies or underwriters may demand it. What's our threshold for offering it (deal size, contract clauses) and what does the support model look like?
7. **Enterprise SSO timing.** Better Auth supports SAML/OIDC SSO via the `@better-auth/sso` plugin. Pilot agencies don't need it; a national underwriter or large multi-state agency probably will. Do we light up the SSO plugin pre-emptively (low cost, slightly more surface area to harden) or wait until the first enterprise contract demands it? Recommendation: enable in code but gate behind a per-tenant feature flag, so the contract conversation doesn't become a "build it first" delay.

---

*End of document.*
