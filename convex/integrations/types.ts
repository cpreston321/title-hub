// Adapter contract for external title-stack integrations (SoftPro 360,
// Qualia, ResWare, Encompass, ...). One module per system implements this
// interface; the runner in `convex/integrationsRunner.ts` drives them
// uniformly so retry/timeout/concurrency behavior stays consistent.
//
// Why a `FileSnapshot` instead of pushing each system's native shape into
// the rest of the codebase: every adapter is responsible for normalizing
// to one shape, so the upsert path doesn't grow a switch statement per
// vendor as the adapter list grows.

// "SoftPro 360" is the connector framework — covers both SoftPro Select and
// SoftPro Standard customers who have 360 licensed (the typical case).
// "SoftPro Standard" here refers to the *legacy direct* integration mode
// for customers running Standard without 360 — DB read, watched-folder
// export, or the older COM API. Different transport, different adapter.
export type IntegrationKind =
  | "softpro_360"
  | "softpro_standard"
  | "qualia"
  | "resware"
  | "encompass"
  | "mock"

export type FileSnapshotParty = {
  role: string
  legalName: string
  partyType: "person" | "entity" | "trust" | "estate"
  capacity?: string
}

export type FileSnapshotAddress = {
  line1: string
  line2?: string
  city: string
  state: string
  zip: string
}

export type FileSnapshot = {
  externalId: string
  fileNumber: string
  externalStatus?: string
  stateCode?: string
  countyFips?: string
  transactionType?: string
  propertyApn?: string
  propertyAddress?: FileSnapshotAddress
  parties: Array<FileSnapshotParty>
  // Source-system updatedAt; we trust this for incremental sync ordering but
  // never write it onto our domain rows verbatim.
  updatedAt: number
}

// Adapters get a small, deliberately-narrow context. They cannot touch
// the database directly — the runner is the only seam that does.
export type AdapterContext = {
  // Adapter-specific configuration (base URL, account id, etc.).
  // Stored as `integrations.config` on the row. Adapters validate.
  config: unknown
  // Plaintext credentials, resolved from `integrations.credentialsToken`
  // by the runner immediately before invoking the adapter. `null` when the
  // integration was created without any (e.g. the mock adapter).
  credentials: unknown | null
  // Implementations should respect this when set, primarily so we can run
  // adapters in offline mode under tests and during local development.
  mock: boolean
}

export type ListChangedResult = {
  externalIds: Array<string>
  // Opaque cursor handed back to the adapter on the next call. Adapters that
  // can't paginate should always return null.
  nextCursor: string | null
}

// "pull" — server calls the source on a schedule (`runSync` → adapter
//   methods). 360, Qualia, ResWare, Encompass, Mock.
// "push" — a customer-side agent posts FileSnapshots to our agent
//   endpoints. Adapter methods are not invoked by the runner. SoftPro
//   Standard direct lives here.
export type IntegrationMode = "pull" | "push"

export interface Adapter {
  kind: IntegrationKind
  mode: IntegrationMode
  // Cheap round-trip to verify creds + reachability. Never throws — adapters
  // surface failures via { ok: false, detail }.
  testConnection: (
    ctx: AdapterContext,
  ) => Promise<{ ok: boolean; detail?: string }>
  // Returns external file ids changed since the given timestamp. Adapters
  // may use either `since` or the prior `cursor`; the runner persists
  // whichever shape the adapter returns.
  listChangedSince: (
    ctx: AdapterContext,
    since: number,
    cursor: string | null,
  ) => Promise<ListChangedResult>
  // Pulls a single file's full snapshot.
  fetchFile: (
    ctx: AdapterContext,
    externalId: string,
  ) => Promise<FileSnapshot>
}
