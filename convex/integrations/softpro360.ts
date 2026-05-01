import type {
  Adapter,
  AdapterContext,
  FileSnapshot,
  ListChangedResult,
} from './types'

// SoftPro 360 adapter. Covers both SoftPro Select and SoftPro Standard
// customers, *as long as* the customer has 360 licensed (the typical case
// for production agencies — 360 is how SoftPro routes to underwriters and
// e-recording vendors). Standard-without-360 has its own adapter
// (`softproStandard.ts`) — different transport entirely.
//
// Sprint 6 ships the shape of this adapter — the network calls are
// stubbed behind `ctx.mock` so the rest of the platform can run end-to-end
// against deterministic data. When real SoftPro credentials land we fill
// in the four `// TODO(softpro_360)` blocks below.
//
// `config` shape (set by the admin in the settings UI):
//
//   {
//     baseUrl: "https://protrust.example/api",
//     accountId: "acme-titles",
//   }
//
// `credentials` is the value pulled from the NPI tokenization path. Today
// we assume bearer-token auth; if SoftPro requires HMAC or OAuth client
// credentials the credential blob shape can be widened without breaking
// the adapter contract.

type SoftProConfig = {
  baseUrl: string
  accountId: string
}

type SoftProCredentials = {
  bearerToken: string
}

function readConfig(ctx: AdapterContext): SoftProConfig {
  const c = ctx.config as Partial<SoftProConfig> | null | undefined
  if (!c || typeof c.baseUrl !== 'string' || typeof c.accountId !== 'string') {
    throw new Error('SOFTPRO_CONFIG_INVALID')
  }
  return { baseUrl: c.baseUrl, accountId: c.accountId }
}

function readCreds(ctx: AdapterContext): SoftProCredentials | null {
  const c = ctx.credentials as Partial<SoftProCredentials> | null | undefined
  if (!c || typeof c.bearerToken !== 'string') return null
  return { bearerToken: c.bearerToken }
}

// Stubbed snapshot returned when the adapter is in mock mode. Realistic
// enough to populate the dashboard and exercise the upsert path.
const STUB_SNAPSHOT: FileSnapshot = {
  externalId: 'SP-STUB-0001',
  fileNumber: 'SP-STUB-0001',
  externalStatus: 'in_exam',
  stateCode: 'IN',
  countyFips: '18097',
  transactionType: 'purchase',
  propertyAddress: {
    line1: '100 N Capitol Ave',
    city: 'Indianapolis',
    state: 'IN',
    zip: '46204',
  },
  parties: [
    { role: 'buyer', legalName: 'Stub Buyer', partyType: 'person' },
    { role: 'seller', legalName: 'Stub Seller LLC', partyType: 'entity' },
  ],
  updatedAt: 1_731_500_000_000,
}

export const softpro360Adapter: Adapter = {
  kind: 'softpro_360',
  mode: 'pull',

  async testConnection(ctx) {
    if (ctx.mock) return { ok: true, detail: 'softpro adapter (mock mode)' }

    let config: SoftProConfig
    try {
      config = readConfig(ctx)
    } catch (err) {
      return { ok: false, detail: (err as Error).message }
    }
    const creds = readCreds(ctx)
    if (!creds) return { ok: false, detail: 'MISSING_CREDENTIALS' }

    // TODO(softpro_360): replace with the real ping endpoint once we have a
    // SoftPro 360 sandbox. Shape kept here so swapping it in is mechanical.
    try {
      const res = await fetch(`${config.baseUrl}/v1/ping`, {
        headers: {
          Authorization: `Bearer ${creds.bearerToken}`,
          'X-SoftPro-Account': config.accountId,
        },
      })
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      }
    }
  },

  async listChangedSince(ctx, since, cursor): Promise<ListChangedResult> {
    if (ctx.mock) {
      // Deterministic single-page response. Cursor advances to a sentinel
      // so a second call returns nothing — exercises pagination logic.
      if (cursor === 'DONE') return { externalIds: [], nextCursor: null }
      return { externalIds: [STUB_SNAPSHOT.externalId], nextCursor: 'DONE' }
    }

    const config = readConfig(ctx)
    const creds = readCreds(ctx)
    if (!creds) throw new Error('SOFTPRO_MISSING_CREDENTIALS')

    // TODO(softpro_360): real endpoint + pagination once we have a sandbox.
    const url = new URL(`${config.baseUrl}/v1/files/changed`)
    url.searchParams.set('since', String(since))
    if (cursor) url.searchParams.set('cursor', cursor)

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${creds.bearerToken}`,
        'X-SoftPro-Account': config.accountId,
      },
    })
    if (!res.ok) throw new Error(`SOFTPRO_HTTP_${res.status}`)
    const body = (await res.json()) as {
      externalIds: Array<string>
      nextCursor: string | null
    }
    return {
      externalIds: Array.isArray(body.externalIds) ? body.externalIds : [],
      nextCursor: body.nextCursor ?? null,
    }
  },

  async fetchFile(ctx, externalId): Promise<FileSnapshot> {
    if (ctx.mock) {
      if (externalId !== STUB_SNAPSHOT.externalId) {
        throw new Error(`SOFTPRO_STUB_NOT_FOUND:${externalId}`)
      }
      return STUB_SNAPSHOT
    }

    const config = readConfig(ctx)
    const creds = readCreds(ctx)
    if (!creds) throw new Error('SOFTPRO_MISSING_CREDENTIALS')

    // TODO(softpro_360): map the real SoftPro file payload onto FileSnapshot.
    const res = await fetch(
      `${config.baseUrl}/v1/files/${encodeURIComponent(externalId)}`,
      {
        headers: {
          Authorization: `Bearer ${creds.bearerToken}`,
          'X-SoftPro-Account': config.accountId,
        },
      }
    )
    if (!res.ok) throw new Error(`SOFTPRO_HTTP_${res.status}`)
    const body = (await res.json()) as FileSnapshot
    return body
  },
}
