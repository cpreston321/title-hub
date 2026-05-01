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

  test("resolveWith records chosen document + value and survives re-reconcile", async () => {
    const { t, alice, fileId } = await setup()
    const paDocId = await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "purchase_agreement",
      "PA",
      PA_PAYLOAD,
    )
    const c1DocId = await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "counter_offer",
      "C1",
      C1_PAYLOAD,
    )

    await alice.asUser.mutation(api.reconciliation.runForFile, { fileId })
    const findings = await alice.asUser.query(api.reconciliation.listForFile, {
      fileId,
    })
    const priceFinding = findings.find(
      (f: { findingType: string }) => f.findingType === "price_amended",
    )!
    expect(priceFinding).toBeDefined()
    expect(priceFinding.involvedDocumentIds).toEqual(
      expect.arrayContaining([paDocId, c1DocId]),
    )

    await alice.asUser.mutation(api.reconciliation.resolveWith, {
      findingId: priceFinding._id,
      documentId: c1DocId,
      value: 233600,
    })

    const afterResolve = await alice.asUser.query(
      api.reconciliation.listForFile,
      { fileId },
    )
    const resolved = afterResolve.find(
      (f: { _id: string }) => f._id === priceFinding._id,
    )!
    expect(resolved.status).toBe("resolved")
    expect(resolved.resolvedDocumentId).toBe(c1DocId)
    expect(resolved.resolvedValue).toBe(233600)
    expect(resolved.resolvedByMemberId).toBeDefined()
    expect(resolved.resolvedAt).toBeDefined()

    // Re-reconcile: open findings get wiped, the resolved decision survives.
    await alice.asUser.mutation(api.reconciliation.runForFile, { fileId })
    const afterRerun = await alice.asUser.query(
      api.reconciliation.listForFile,
      { fileId },
    )
    const stillResolved = afterRerun.find(
      (f: { _id: string }) => f._id === priceFinding._id,
    )!
    expect(stillResolved.status).toBe("resolved")
    expect(stillResolved.resolvedDocumentId).toBe(c1DocId)
    expect(stillResolved.resolvedValue).toBe(233600)
  })

  test("resolveWith rejects a document that wasn't involved in the finding", async () => {
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

    // Upload a third unrelated document not cited by the price-amended finding.
    const otherDocId = await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "other",
      "Random doc",
      {
        documentKind: "other",
        parties: [],
        property: null,
        financial: null,
        dates: null,
        titleCompany: null,
        contingencies: [],
        amendments: [],
        notes: [],
      },
    )

    await alice.asUser.mutation(api.reconciliation.runForFile, { fileId })
    const findings = await alice.asUser.query(api.reconciliation.listForFile, {
      fileId,
    })
    const priceFinding = findings.find(
      (f: { findingType: string }) => f.findingType === "price_amended",
    )!

    await expect(
      alice.asUser.mutation(api.reconciliation.resolveWith, {
        findingId: priceFinding._id,
        documentId: otherDocId,
        value: 0,
      }),
    ).rejects.toThrow(/DOCUMENT_NOT_INVOLVED/)
  })

  test("resolveWith promotes price_amended to file.purchasePrice", async () => {
    const { t, alice, fileId } = await setup()
    await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "purchase_agreement",
      "PA",
      PA_PAYLOAD,
    )
    const c1DocId = await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "counter_offer",
      "C1",
      C1_PAYLOAD,
    )
    await alice.asUser.mutation(api.reconciliation.runForFile, { fileId })
    const findings = await alice.asUser.query(api.reconciliation.listForFile, {
      fileId,
    })
    const priceFinding = findings.find(
      (f: { findingType: string }) => f.findingType === "price_amended",
    )!

    const result = await alice.asUser.mutation(
      api.reconciliation.resolveWith,
      { findingId: priceFinding._id, documentId: c1DocId, value: 233600 },
    )
    expect(result.promoted).toEqual({
      target: "file",
      id: fileId,
      fields: ["purchasePrice"],
    })

    const file = await t.run((ctx) => ctx.db.get(fileId))
    expect(file?.purchasePrice).toBe(233600)
  })

  test("resolveWith promotes title_company_change to file.titleCompany", async () => {
    const { t, alice, fileId } = await setup()
    await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "purchase_agreement",
      "PA",
      PA_PAYLOAD,
    )
    const c1DocId = await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "counter_offer",
      "C1",
      C1_PAYLOAD,
    )
    await alice.asUser.mutation(api.reconciliation.runForFile, { fileId })
    const findings = await alice.asUser.query(api.reconciliation.listForFile, {
      fileId,
    })
    const tcFinding = findings.find(
      (f: { findingType: string }) =>
        f.findingType === "title_company_change",
    )!

    await alice.asUser.mutation(api.reconciliation.resolveWith, {
      findingId: tcFinding._id,
      documentId: c1DocId,
      value: {
        name: "Quality Title Insurance",
        phone: "317-780-5700",
        selectedBy: "seller",
      },
    })

    const file = await t.run((ctx) => ctx.db.get(fileId))
    expect(file?.titleCompany?.name).toBe("Quality Title Insurance")
    expect(file?.titleCompany?.selectedBy).toBe("seller")
    expect(file?.titleCompany?.phone).toBe("317-780-5700")
  })

  test("resolveWith promotes financing_window_change to file.financingApprovalDays", async () => {
    const { t, alice, fileId } = await setup()
    await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "purchase_agreement",
      "PA",
      PA_PAYLOAD,
    )
    const c1DocId = await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "counter_offer",
      "C1",
      C1_PAYLOAD,
    )
    await alice.asUser.mutation(api.reconciliation.runForFile, { fileId })
    const findings = await alice.asUser.query(api.reconciliation.listForFile, {
      fileId,
    })
    const fwFinding = findings.find(
      (f: { findingType: string }) =>
        f.findingType === "financing_window_change",
    )!

    await alice.asUser.mutation(api.reconciliation.resolveWith, {
      findingId: fwFinding._id,
      documentId: c1DocId,
      value: 25,
    })

    const file = await t.run((ctx) => ctx.db.get(fileId))
    expect(file?.financingApprovalDays).toBe(25)
  })

  test("resolveWith promotes party_name_mismatch to parties.legalName when role uniquely matches", async () => {
    const { t, alice, fileId } = await setup()
    // Establish a buyer party on the file so the role match is unique.
    await alice.asUser.mutation(api.files.addParty, {
      fileId,
      partyType: "person",
      legalName: "M Hicks",
      role: "buyer",
    })
    const paDocId = await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "purchase_agreement",
      "PA",
      PA_PAYLOAD,
    )
    // Same buyer with a different legal name in a counter offer.
    const variantPayload = {
      ...C1_PAYLOAD,
      parties: [
        { role: "buyer", legalName: "Michelle K Hicks" },
        { role: "seller", legalName: "Rene S Kotter", capacity: "AIF" },
      ],
    }
    const c1DocId = await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "counter_offer",
      "C1",
      variantPayload,
    )

    await alice.asUser.mutation(api.reconciliation.runForFile, { fileId })
    const findings = await alice.asUser.query(api.reconciliation.listForFile, {
      fileId,
    })
    const nameFinding = findings.find(
      (f: { findingType: string; rawDetail: { role?: string } }) =>
        f.findingType === "party_name_mismatch" && f.rawDetail.role === "buyer",
    )!
    expect(nameFinding).toBeDefined()
    expect(nameFinding.involvedDocumentIds).toEqual(
      expect.arrayContaining([paDocId, c1DocId]),
    )

    const result = await alice.asUser.mutation(
      api.reconciliation.resolveWith,
      {
        findingId: nameFinding._id,
        documentId: c1DocId,
        value: "Michelle K Hicks",
      },
    )
    expect(result.promoted?.target).toBe("party")
    expect(result.promoted?.fields).toEqual(["legalName"])

    // The single buyer-role fileParty's underlying party should now carry the
    // chosen legal name.
    const updatedParty = await t.run(async (ctx) => {
      const fps = await ctx.db
        .query("fileParties")
        .withIndex("by_tenant_file", (q) =>
          q.eq("tenantId", nameFinding.tenantId).eq("fileId", fileId),
        )
        .collect()
      const buyer = fps.find((fp) => fp.role === "buyer")
      return buyer ? ctx.db.get(buyer.partyId) : null
    })
    expect(updatedParty?.legalName).toBe("Michelle K Hicks")
  })

  test("resolveWith does NOT promote party_name_mismatch when the role matches multiple file parties", async () => {
    const { t, alice, fileId } = await setup()
    // Two buyer-role parties → ambiguous; promotion must skip without throwing.
    await alice.asUser.mutation(api.files.addParty, {
      fileId,
      partyType: "person",
      legalName: "First Buyer",
      role: "buyer",
    })
    await alice.asUser.mutation(api.files.addParty, {
      fileId,
      partyType: "person",
      legalName: "Second Buyer",
      role: "buyer",
    })

    await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "purchase_agreement",
      "PA",
      PA_PAYLOAD,
    )
    const c1DocId = await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "counter_offer",
      "C1",
      {
        ...C1_PAYLOAD,
        parties: [
          { role: "buyer", legalName: "Michelle K Hicks" },
          { role: "seller", legalName: "Rene S Kotter", capacity: "AIF" },
        ],
      },
    )

    await alice.asUser.mutation(api.reconciliation.runForFile, { fileId })
    const findings = await alice.asUser.query(api.reconciliation.listForFile, {
      fileId,
    })
    const nameFinding = findings.find(
      (f: { findingType: string; rawDetail: { role?: string } }) =>
        f.findingType === "party_name_mismatch" && f.rawDetail.role === "buyer",
    )!

    const result = await alice.asUser.mutation(
      api.reconciliation.resolveWith,
      {
        findingId: nameFinding._id,
        documentId: c1DocId,
        value: "Michelle K Hicks",
      },
    )
    expect(result.promoted).toBeNull()

    // Neither buyer party should have been overwritten.
    const buyerNames = await t.run(async (ctx) => {
      const fps = await ctx.db
        .query("fileParties")
        .withIndex("by_tenant_file", (q) =>
          q.eq("tenantId", nameFinding.tenantId).eq("fileId", fileId),
        )
        .collect()
      const names = await Promise.all(
        fps
          .filter((fp) => fp.role === "buyer")
          .map(async (fp) => (await ctx.db.get(fp.partyId))?.legalName),
      )
      return names
    })
    expect(buyerNames.sort()).toEqual(["First Buyer", "Second Buyer"])
  })

  test("resolveWith requires editor role", async () => {
    const { t, alice, fileId } = await setup()
    await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "purchase_agreement",
      "PA",
      PA_PAYLOAD,
    )
    const c1DocId = await attachDocWithExtraction(
      t,
      alice,
      fileId,
      "counter_offer",
      "C1",
      C1_PAYLOAD,
    )
    await alice.asUser.mutation(api.reconciliation.runForFile, { fileId })
    const findings = await alice.asUser.query(api.reconciliation.listForFile, {
      fileId,
    })
    const priceFinding = findings.find(
      (f: { findingType: string }) => f.findingType === "price_amended",
    )!

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
      alice.asUser.mutation(api.reconciliation.resolveWith, {
        findingId: priceFinding._id,
        documentId: c1DocId,
        value: 233600,
      }),
    ).rejects.toThrow(/FORBIDDEN/)
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
