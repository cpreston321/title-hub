import type { Adapter, FileSnapshot } from './types'

// Deterministic in-memory adapter. Lets the dashboard, sync runner, and
// settings UI exercise the full integration path without a real external
// system. Used by Sprint 6 acceptance tests and as the default adapter for
// local development.
//
// Files are seeded against `_creationTime` so two runs of the same test
// produce the same external IDs in the same order.

// Document fixtures attached to mock files. Not part of the FileSnapshot
// adapter contract (real adapters can't push extracted data through the
// integration boundary like this) — the runner consumes these
// out-of-band when `kind === 'mock'` to seed a complete pipeline:
// documents → succeeded extractions → reconciliation findings. Lets the
// Order Management UI render real readiness signals from a mock sync.
export type MockDocumentFixture = {
  docType: string
  title: string
  // Becomes documentExtractions.payload — the same shape Claude returns
  // from extractionsRunner. The reconciliation engine reads these directly
  // to produce findings, so the payload schema matters.
  extractionPayload: unknown
}

export const MOCK_DOCUMENT_FIXTURES: Record<
  string,
  ReadonlyArray<MockDocumentFixture>
> = {
  // 3324 Corey Dr — PA + counter offer with conflicts. Reconciliation will
  // surface price_amended, earnest_money_refundability_change,
  // financing_window_change, and title_company_change.
  'MOCK-2026-001': [
    {
      docType: 'purchase_agreement',
      title: 'PA - 3324 Corey Dr.pdf',
      extractionPayload: {
        documentKind: 'purchase_agreement',
        parties: [
          { role: 'buyer', legalName: 'Michelle Hicks' },
          { role: 'seller', legalName: 'Rene S Kotter', capacity: 'AIF' },
        ],
        property: { address: '3324 Corey Dr, Indianapolis, IN 46227' },
        financial: {
          purchasePrice: 225000,
          earnestMoney: { amount: 500, refundable: true, depositDays: 2 },
          sellerConcessions: 3200,
        },
        dates: {
          effectiveDate: '2026-02-02',
          closingDate: '2026-03-04',
          financingApprovalDays: 40,
        },
        titleCompany: { name: 'Near North Title', selectedBy: 'buyer' },
        contingencies: ['financing', 'inspection'],
        amendments: [],
        notes: [],
      },
    },
    {
      docType: 'counter_offer',
      title: 'C1 - 3324 Corey Dr.pdf',
      extractionPayload: {
        documentKind: 'counter_offer',
        parties: [
          { role: 'buyer', legalName: 'Michelle Hicks' },
          { role: 'seller', legalName: 'Rene S Kotter', capacity: 'AIF' },
        ],
        property: { address: '3324 Corey Dr, Indianapolis, IN 46227' },
        financial: {
          purchasePrice: 233600,
          earnestMoney: { refundable: false },
        },
        dates: { closingDate: '2026-03-04', financingApprovalDays: 25 },
        titleCompany: {
          name: 'Quality Title Insurance',
          phone: '317-780-5700',
          selectedBy: 'seller',
        },
        contingencies: ['financing', 'inspection'],
        amendments: [
          'Purchase price raised to $233,600 (from $225,000).',
          'Earnest money is non-refundable.',
          'Financing approval deadline reduced to 25 days after acceptance.',
          'Seller selects title company: Quality Title Insurance.',
        ],
        notes: [],
      },
    },
  ],
  // 5215 E Washington — refi with one document, no conflicts.
  'MOCK-2026-002': [
    {
      docType: 'lender_instructions',
      title: 'Lender Instructions - 5215 E Washington.pdf',
      extractionPayload: {
        documentKind: 'lender_instructions',
        parties: [
          { role: 'borrower', legalName: 'Anita Borrower' },
          { role: 'lender', legalName: 'First Indiana Bank' },
        ],
        property: { address: '5215 E Washington St, Indianapolis, IN 46219' },
        financial: { loanAmount: 175000 },
        dates: { closingDate: '2026-03-15' },
        notes: [],
      },
    },
  ],
  // 1 Monument Cir — single commercial PA, single party.
  'MOCK-2026-003': [
    {
      docType: 'purchase_agreement',
      title: 'PA - 1 Monument Cir.pdf',
      extractionPayload: {
        documentKind: 'purchase_agreement',
        parties: [
          { role: 'buyer', legalName: 'Hicks Holdings LLC' },
          { role: 'seller', legalName: 'Circle Tower LLC' },
        ],
        property: { address: '1 Monument Cir, Indianapolis, IN 46204' },
        financial: { purchasePrice: 4_250_000 },
        dates: {
          effectiveDate: '2026-01-15',
          closingDate: '2026-04-30',
        },
        titleCompany: { name: 'Quality Title Insurance', selectedBy: 'buyer' },
        contingencies: ['financing'],
        amendments: [],
        notes: [],
      },
    },
  ],
}

const MOCK_FILES: ReadonlyArray<FileSnapshot> = [
  {
    externalId: 'MOCK-2026-001',
    fileNumber: 'MOCK-2026-001',
    externalStatus: 'in_exam',
    stateCode: 'IN',
    countyFips: '18097',
    transactionType: 'purchase',
    propertyApn: '491517124083000500',
    propertyAddress: {
      line1: '3324 Corey Dr',
      city: 'Indianapolis',
      state: 'IN',
      zip: '46227',
    },
    parties: [
      {
        role: 'buyer',
        legalName: 'Michelle Hicks',
        partyType: 'person',
      },
      {
        role: 'seller',
        legalName: 'Rene S Kotter',
        partyType: 'person',
        capacity: 'AIF',
      },
    ],
    updatedAt: 1_730_000_000_000,
  },
  {
    externalId: 'MOCK-2026-002',
    fileNumber: 'MOCK-2026-002',
    externalStatus: 'opened',
    stateCode: 'IN',
    countyFips: '18097',
    transactionType: 'refi',
    propertyAddress: {
      line1: '5215 E Washington St',
      city: 'Indianapolis',
      state: 'IN',
      zip: '46219',
    },
    parties: [
      {
        role: 'borrower',
        legalName: 'Anita Borrower',
        partyType: 'person',
      },
    ],
    updatedAt: 1_730_500_000_000,
  },
  {
    externalId: 'MOCK-2026-003',
    fileNumber: 'MOCK-2026-003',
    externalStatus: 'cleared',
    stateCode: 'IN',
    countyFips: '18057',
    transactionType: 'commercial',
    propertyAddress: {
      line1: '1 Monument Cir',
      city: 'Indianapolis',
      state: 'IN',
      zip: '46204',
    },
    parties: [
      {
        role: 'buyer',
        legalName: 'Hicks Holdings LLC',
        partyType: 'entity',
      },
    ],
    updatedAt: 1_731_000_000_000,
  },
]

export const mockAdapter: Adapter = {
  kind: 'mock',
  mode: 'pull',
  async testConnection() {
    return { ok: true, detail: 'mock adapter — always reachable' }
  },
  async listChangedSince(_ctx, since) {
    const ids = MOCK_FILES.filter((f) => f.updatedAt >= since).map(
      (f) => f.externalId
    )
    return { externalIds: ids, nextCursor: null }
  },
  async fetchFile(_ctx, externalId) {
    const f = MOCK_FILES.find((x) => x.externalId === externalId)
    if (!f) throw new Error(`MOCK_FILE_NOT_FOUND:${externalId}`)
    return f
  },
}
