import type { Adapter, FileSnapshot } from "./types"

// Deterministic in-memory adapter. Lets the dashboard, sync runner, and
// settings UI exercise the full integration path without a real external
// system. Used by Sprint 6 acceptance tests and as the default adapter for
// local development.
//
// Files are seeded against `_creationTime` so two runs of the same test
// produce the same external IDs in the same order.

const MOCK_FILES: ReadonlyArray<FileSnapshot> = [
  {
    externalId: "MOCK-2026-001",
    fileNumber: "MOCK-2026-001",
    externalStatus: "in_exam",
    stateCode: "IN",
    countyFips: "18097",
    transactionType: "purchase",
    propertyApn: "491517124083000500",
    propertyAddress: {
      line1: "3324 Corey Dr",
      city: "Indianapolis",
      state: "IN",
      zip: "46227",
    },
    parties: [
      {
        role: "buyer",
        legalName: "Michelle Hicks",
        partyType: "person",
      },
      {
        role: "seller",
        legalName: "Rene S Kotter",
        partyType: "person",
        capacity: "AIF",
      },
    ],
    updatedAt: 1_730_000_000_000,
  },
  {
    externalId: "MOCK-2026-002",
    fileNumber: "MOCK-2026-002",
    externalStatus: "opened",
    stateCode: "IN",
    countyFips: "18097",
    transactionType: "refi",
    propertyAddress: {
      line1: "5215 E Washington St",
      city: "Indianapolis",
      state: "IN",
      zip: "46219",
    },
    parties: [
      {
        role: "borrower",
        legalName: "Anita Borrower",
        partyType: "person",
      },
    ],
    updatedAt: 1_730_500_000_000,
  },
  {
    externalId: "MOCK-2026-003",
    fileNumber: "MOCK-2026-003",
    externalStatus: "cleared",
    stateCode: "IN",
    countyFips: "18057",
    transactionType: "commercial",
    propertyAddress: {
      line1: "1 Monument Cir",
      city: "Indianapolis",
      state: "IN",
      zip: "46204",
    },
    parties: [
      {
        role: "buyer",
        legalName: "Hicks Holdings LLC",
        partyType: "entity",
      },
    ],
    updatedAt: 1_731_000_000_000,
  },
]

export const mockAdapter: Adapter = {
  kind: "mock",
  mode: "pull",
  async testConnection() {
    return { ok: true, detail: "mock adapter — always reachable" }
  },
  async listChangedSince(_ctx, since) {
    const ids = MOCK_FILES.filter((f) => f.updatedAt >= since).map(
      (f) => f.externalId,
    )
    return { externalIds: ids, nextCursor: null }
  },
  async fetchFile(_ctx, externalId) {
    const f = MOCK_FILES.find((x) => x.externalId === externalId)
    if (!f) throw new Error(`MOCK_FILE_NOT_FOUND:${externalId}`)
    return f
  },
}
