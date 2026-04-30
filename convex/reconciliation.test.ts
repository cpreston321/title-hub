/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import schema from "./schema"
import {
  createOrganizationAsUser,
  makeBetterAuthUser,
  registerLocalBetterAuth,
} from "./lib/testHelpers"
import type { Id } from "./_generated/dataModel"

const modules = import.meta.glob("./**/*.ts")
const betterAuthModules = import.meta.glob("./betterAuth/**/*.ts")

// Canonical Corey Dr fixtures — must stay in sync with MOCK_BY_DOCTYPE in
// convex/extractionsRunner.ts. The reconciliation engine compares these.
const PA_PAYLOAD = {
  documentKind: "purchase_agreement",
  parties: [
    { role: "buyer", legalName: "Michelle Hicks" },
    { role: "seller", legalName: "Rene S Kotter", capacity: "AIF" },
  ],
  property: { address: "3324 Corey Dr, Indianapolis, IN 46227" },
  financial: {
    purchasePrice: 225000,
    earnestMoney: { amount: 500, refundable: true, depositDays: 2 },
    sellerConcessions: 3200,
  },
  dates: {
    effectiveDate: "2026-02-02",
    closingDate: "2026-03-04",
    financingApprovalDays: 40,
  },
  titleCompany: { name: "Near North Title", selectedBy: "buyer" },
  contingencies: ["financing", "inspection"],
  amendments: [],
  notes: [],
}

const C1_PAYLOAD = {
  documentKind: "counter_offer",
  parties: [
    { role: "buyer", legalName: "Michelle Hicks" },
    { role: "seller", legalName: "Rene S Kotter", capacity: "AIF" },
  ],
  property: { address: "3324 Corey Dr, Indianapolis, IN 46227" },
  financial: {
    purchasePrice: 233600,
    earnestMoney: { refundable: false },
  },
  dates: { closingDate: "2026-03-04", financingApprovalDays: 25 },
  titleCompany: {
    name: "Quality Title Insurance",
    phone: "317-780-5700",
    selectedBy: "seller",
  },
  contingencies: ["financing", "inspection"],
  amendments: [
    "Purchase price raised to $233,600 (from $225,000).",
    "Earnest money is non-refundable.",
    "Financing approval deadline reduced to 25 days after acceptance.",
    "Seller selects title company: Quality Title Insurance.",
  ],
  notes: [],
}

async function setup() {
  const t = convexTest(schema, modules)
  registerLocalBetterAuth(t, betterAuthModules)
  await t.mutation(api.seed.indiana, {})

  const alice = await makeBetterAuthUser(t, "alice@a.example", "Alice")
  await createOrganizationAsUser(t, alice.userId, alice.sessionId, {
    slug: "agency-a",
    name: "Agency A LLC",
  })

  const counties = await t.run((ctx) => ctx.db.query("counties").take(200))
  const marion = counties.find((c) => c.fipsCode === "18097")!

  const file = await alice.asUser.mutation(api.files.create, {
    fileNumber: "QT-COREY-1",
    countyId: marion._id,
    transactionType: "purchase",
  })

  return { t, alice, marion, fileId: file.fileId }
}

async function attachDocWithExtraction(
  t: ReturnType<typeof convexTest>,
  alice: { asUser: { mutation: Function }; userId: string },
  fileId: Id<"files">,
  docType: string,
  title: string,
  payload: unknown,
): Promise<Id<"documents">> {
  const storageId = await t.run(async (ctx) =>
    ctx.storage.store(new Blob([title], { type: "application/pdf" })),
  )
  const { docId } = (await alice.asUser.mutation(api.files.recordDocument, {
    fileId,
    storageId,
    docType,
    title,
  })) as { docId: Id<"documents"> }

  // Insert a synthetic succeeded extraction directly — the reconciliation
  // engine is the unit under test, not the LLM scheduler.
  await t.run(async (ctx) => {
    const doc = await ctx.db.get(docId)
    if (!doc) throw new Error("doc gone")
    await ctx.db.insert("documentExtractions", {
      tenantId: doc.tenantId,
      fileId,
      documentId: docId,
      status: "succeeded",
      payload,
      modelId: "test-fixture",
      source: "mock",
      startedAt: Date.now(),
      completedAt: Date.now(),
    })
  })

  return docId
}

describe("Sprint 4 reconciliation engine", () => {
  test("Corey Dr fixture: PA + counter offer surface the four expected findings", async () => {
    const { t, alice, fileId } = await setup()
    await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "purchase_agreement",
      "PA - 3324 Corey Dr.pdf",
      PA_PAYLOAD,
    )
    await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "counter_offer",
      "C1 - 3324 Corey Dr.pdf",
      C1_PAYLOAD,
    )

    const result = await alice.asUser.mutation(api.reconciliation.runForFile, {
      fileId,
    })
    expect(result.counts.warn).toBeGreaterThanOrEqual(3)
    expect(result.counts.block).toBeGreaterThanOrEqual(1)

    const findings = await alice.asUser.query(api.reconciliation.listForFile, {
      fileId,
    })
    const types = findings.map((f: { findingType: string }) => f.findingType).sort()

    expect(types).toContain("price_amended")
    expect(types).toContain("title_company_change")
    expect(types).toContain("earnest_money_refundability_change")
    expect(types).toContain("financing_window_change")

    const block = findings.find(
      (f: { findingType: string; severity: string }) =>
        f.findingType === "earnest_money_refundability_change",
    )
    expect(block?.severity).toBe("block")
  })

  test("re-running supersedes prior open findings; resolved ones survive", async () => {
    const { t, alice, fileId } = await setup()
    await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "purchase_agreement",
      "PA",
      PA_PAYLOAD,
    )
    await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "counter_offer",
      "C1",
      C1_PAYLOAD,
    )

    await alice.asUser.mutation(api.reconciliation.runForFile, { fileId })

    const initial = await alice.asUser.query(api.reconciliation.listForFile, {
      fileId,
    })
    const block = initial.find(
      (f: { severity: string }) => f.severity === "block",
    )!
    expect(block).toBeDefined()
    await alice.asUser.mutation(api.reconciliation.setStatus, {
      findingId: block._id,
      status: "resolved",
    })

    await alice.asUser.mutation(api.reconciliation.runForFile, { fileId })

    const after = await alice.asUser.query(api.reconciliation.listForFile, {
      fileId,
    })
    const resolved = after.filter(
      (f: { status: string }) => f.status === "resolved",
    )
    expect(resolved).toHaveLength(1)
    expect(resolved[0]._id).toBe(block._id)
  })

  test("a different tenant cannot see another tenant's findings", async () => {
    const { t, alice, fileId } = await setup()
    await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "purchase_agreement",
      "PA",
      PA_PAYLOAD,
    )
    await alice.asUser.mutation(api.reconciliation.runForFile, { fileId })

    const bob = await makeBetterAuthUser(t, "bob@b.example", "Bob")
    await createOrganizationAsUser(t, bob.userId, bob.sessionId, {
      slug: "agency-b",
      name: "Agency B",
    })
    const bobFindings = await bob.asUser.query(
      api.reconciliation.listForFile,
      { fileId },
    )
    expect(bobFindings).toHaveLength(0)
  })

  test("missing_required_documents is emitted when a purchase has only the PA", async () => {
    const { t, alice, fileId } = await setup()
    await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "purchase_agreement",
      "PA",
      PA_PAYLOAD,
    )

    await alice.asUser.mutation(api.reconciliation.runForFile, { fileId })
    const findings = await alice.asUser.query(api.reconciliation.listForFile, {
      fileId,
    })
    const missing = findings.find(
      (f: { findingType: string }) =>
        f.findingType === "missing_required_documents",
    )
    expect(missing).toBeDefined()
    expect(missing!.rawDetail.missing).toEqual(
      expect.arrayContaining(["title_search", "commitment", "closing_disclosure"]),
    )
  })

  test("Sprint 5 vesting: PA with AIF seller → poa_present + decedent flags off", async () => {
    const { t, alice, fileId } = await setup()
    await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "purchase_agreement",
      "PA",
      PA_PAYLOAD,
    )
    await alice.asUser.mutation(api.reconciliation.runForFile, { fileId })
    const findings = await alice.asUser.query(api.reconciliation.listForFile, {
      fileId,
    })
    const types = findings.map((f: { findingType: string }) => f.findingType)
    expect(types).toContain("poa_present")
    expect(types).not.toContain("decedent_indicator")
  })

  test("Sprint 5 vesting: trust without a trustee → block", async () => {
    const { t, alice, fileId } = await setup()
    const TRUST_PAYLOAD = {
      documentKind: "deed",
      parties: [
        { role: "seller", legalName: "The Smith Family Trust" },
        { role: "buyer", legalName: "Jane Doe" },
      ],
      property: null,
      financial: null,
      dates: null,
      titleCompany: null,
      contingencies: [],
      amendments: [],
      notes: [],
    }
    await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "deed",
      "Trust deed",
      TRUST_PAYLOAD,
    )
    await alice.asUser.mutation(api.reconciliation.runForFile, { fileId })
    const findings = await alice.asUser.query(api.reconciliation.listForFile, {
      fileId,
    })
    const trustFinding = findings.find(
      (f: { findingType: string }) => f.findingType === "trust_without_trustee",
    )
    expect(trustFinding).toBeDefined()
    expect(trustFinding!.severity).toBe("block")
  })

  test("Sprint 5 vesting: trust with trustee → no trust_without_trustee finding", async () => {
    const { t, alice, fileId } = await setup()
    const PAYLOAD = {
      documentKind: "deed",
      parties: [
        { role: "seller", legalName: "The Smith Family Trust" },
        {
          role: "trustee",
          legalName: "Jane Smith",
          capacity: "trustee",
        },
        { role: "buyer", legalName: "Bob Buyer" },
      ],
      property: null,
      financial: null,
      dates: null,
      titleCompany: null,
      contingencies: [],
      amendments: [],
      notes: [],
    }
    await attachDocWithExtraction(t, alice, fileId, "deed", "OK", PAYLOAD)
    await alice.asUser.mutation(api.reconciliation.runForFile, { fileId })
    const findings = await alice.asUser.query(api.reconciliation.listForFile, {
      fileId,
    })
    expect(
      findings.some(
        (f: { findingType: string }) => f.findingType === "trust_without_trustee",
      ),
    ).toBe(false)
  })

  test("Sprint 5 vesting: joint vesting without form → warn", async () => {
    const { t, alice, fileId } = await setup()
    const PAYLOAD = {
      documentKind: "purchase_agreement",
      parties: [
        { role: "buyer", legalName: "John Smith" },
        { role: "buyer", legalName: "Jane Smith" },
        { role: "seller", legalName: "Bob Seller" },
      ],
      property: null,
      financial: null,
      dates: null,
      titleCompany: null,
      contingencies: [],
      amendments: [],
      notes: [],
    }
    await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "purchase_agreement",
      "Joint",
      PAYLOAD,
    )
    await alice.asUser.mutation(api.reconciliation.runForFile, { fileId })
    const findings = await alice.asUser.query(api.reconciliation.listForFile, {
      fileId,
    })
    const joint = findings.find(
      (f: { findingType: string }) => f.findingType === "joint_vesting_unclear",
    )
    expect(joint).toBeDefined()
    expect(joint!.severity).toBe("warn")
  })

  test("non-editor cannot run reconciliation (FORBIDDEN)", async () => {
    const { t, alice, fileId } = await setup()
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("tenantMembers")
        .withIndex("by_betterAuthUser", (q) =>
          q.eq("betterAuthUserId", alice.userId),
        )
        .unique()
      if (m) await ctx.db.patch(m._id, { role: "closer" })
    })
    await expect(
      alice.asUser.mutation(api.reconciliation.runForFile, { fileId }),
    ).rejects.toThrow(/FORBIDDEN/)
  })
})
