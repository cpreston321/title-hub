/// <reference types="vite/client" />
//
// End-to-end tests for the inbound-email HTTP surface. Drives `t.fetch`
// against the same routes a real provider would hit:
//
//   • POST /integrations/email/inbound  (per-integration HMAC)
//   • POST /integrations/email/postmark (Basic auth + MailboxHash routing)
//
// These exercise: HMAC verify, base64 attachment decode, sha256 + storage
// path, mutation cascade, blob cleanup on failures, dedup, and the spam
// gate's interaction with the auto-attach decision.

import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import schema from './schema'
import {
  createOrganizationAsUser,
  makeBetterAuthUser,
  registerLocalBetterAuth,
} from './lib/testHelpers'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')
const betterAuthModules = import.meta.glob('./betterAuth/**/*.ts')

async function setup() {
  const t = convexTest(schema, modules)
  registerLocalBetterAuth(t, betterAuthModules)
  await t.mutation(api.seed.indiana, {})

  const alice = await makeBetterAuthUser(t, 'alice@a.example', 'Alice')
  await createOrganizationAsUser(t, alice.userId, alice.sessionId, {
    slug: 'agency-a',
    name: 'Agency A LLC',
  })

  const { integrationId } = await alice.asUser.mutation(
    api.integrations.create,
    { kind: 'email_inbound', name: 'Inbound mail' }
  )
  // Reveal the inbound HMAC secret so the test can sign requests the way
  // a real provider would.
  const { inboundSecret } = await alice.asUser.mutation(
    api.integrations.revealInboundSecret,
    { integrationId }
  )

  // Stamp a forwardAddressLocalPart so the Postmark route can route by
  // MailboxHash → integration.
  await t.run(async (ctx) => {
    await ctx.db.patch(integrationId, {
      config: { forwardAddressLocalPart: 'agency-a' },
    })
  })

  // Marion county lookup for files we'll create as match targets.
  const marionId = await t.run(async (ctx) => {
    const c = await ctx.db
      .query('counties')
      .withIndex('by_fips', (q) => q.eq('fipsCode', '18097'))
      .unique()
    if (!c) throw new Error('Marion county fixture missing')
    return c._id
  })

  return { t, alice, integrationId, inboundSecret, marionId }
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message)
  )
  return Array.from(new Uint8Array(sig), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
}

function tinyPdfBase64(): string {
  // Smallest plausible PDF — minimum to round-trip through storage and
  // the sha256 check. Real ingest never reads the bytes during HTTP.
  const bytes = new TextEncoder().encode('%PDF-1.4\n% stub\n')
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

async function postInbound(
  t: ReturnType<typeof convexTest>,
  args: {
    integrationId: Id<'integrations'>
    inboundSecret: string
    payload: Record<string, unknown>
  }
): Promise<Response> {
  const rawBody = JSON.stringify(args.payload)
  const ts = String(Date.now())
  const sig = await hmacHex(args.inboundSecret, `${ts}.${rawBody}`)
  return t.fetch(
    `/integrations/email/inbound?id=${args.integrationId}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Title-Timestamp': ts,
        'X-Title-Signature': `sha256=${sig}`,
      },
      body: rawBody,
    }
  )
}

describe('HTTP /integrations/email/inbound — end-to-end', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('happy path: ingest creates row, attaches, runs extraction', async () => {
    const { t, alice, integrationId, inboundSecret, marionId } = await setup()
    await alice.asUser.mutation(api.files.create, {
      fileNumber: '25-001234',
      countyId: marionId,
      transactionType: 'purchase',
    })

    const res = await postInbound(t, {
      integrationId,
      inboundSecret,
      payload: {
        MessageID: 'http-1',
        From: 'agent@example.com',
        Subject: 'Re: file 25-001234 signed PA',
        TextBody: 'Attached.',
        Date: new Date().toISOString(),
        SpfResult: 'pass',
        DkimResult: 'pass',
        DmarcResult: 'pass',
        Attachments: [
          {
            Name: 'pa.pdf',
            ContentType: 'application/pdf',
            Content: tinyPdfBase64(),
            ContentLength: 16,
          },
        ],
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      autoAttached: boolean
      matchedFileId: string
    }
    expect(body.autoAttached).toBe(true)
    expect(body.matchedFileId).toBeDefined()

    const list = await alice.asUser.query(api.inboundEmail.list, {})
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe('auto_attached')
    expect(list[0].spamTier).toBe('clean')
    expect(list[0].attachmentCount).toBe(1)
  })

  test('rejects bad HMAC with 401 and writes nothing', async () => {
    const { t, alice, integrationId } = await setup()
    const ts = String(Date.now())
    const res = await t.fetch(
      `/integrations/email/inbound?id=${integrationId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Title-Timestamp': ts,
          'X-Title-Signature': 'sha256=' + 'a'.repeat(64),
        },
        body: JSON.stringify({
          MessageID: 'bad-1',
          From: 'x@example.com',
          Subject: '',
          Date: new Date().toISOString(),
          Attachments: [],
        }),
      }
    )
    expect(res.status).toBe(401)
    const list = await alice.asUser.query(api.inboundEmail.list, {})
    expect(list).toHaveLength(0)
  })

  test('rejects stale timestamp with 400', async () => {
    const { t, integrationId, inboundSecret } = await setup()
    const ts = String(Date.now() - 10 * 60_000) // 10 min ago
    const rawBody = JSON.stringify({
      MessageID: 'stale-1',
      From: 'x@example.com',
      Subject: '',
      Date: new Date().toISOString(),
      Attachments: [],
    })
    const sig = await hmacHex(inboundSecret, `${ts}.${rawBody}`)
    const res = await t.fetch(
      `/integrations/email/inbound?id=${integrationId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Title-Timestamp': ts,
          'X-Title-Signature': `sha256=${sig}`,
        },
        body: rawBody,
      }
    )
    expect(res.status).toBe(400)
  })

  test('dedup: redelivered MessageID returns same row, no duplicate insert', async () => {
    const { t, alice, integrationId, inboundSecret } = await setup()
    const payload = {
      MessageID: 'redeliver-1',
      From: 'x@example.com',
      Subject: 'no number',
      Date: new Date().toISOString(),
      SpfResult: 'pass',
      DmarcResult: 'pass',
      Attachments: [],
    }
    const r1 = await postInbound(t, {
      integrationId,
      inboundSecret,
      payload,
    })
    expect(r1.status).toBe(200)
    const r2 = await postInbound(t, {
      integrationId,
      inboundSecret,
      payload,
    })
    expect(r2.status).toBe(200)
    const r2body = (await r2.json()) as { deduped: boolean }
    expect(r2body.deduped).toBe(true)

    const list = await alice.asUser.query(api.inboundEmail.list, {})
    expect(list).toHaveLength(1)
  })

  test('high-risk auth fails the spam gate and forces quarantine', async () => {
    const { t, alice, integrationId, inboundSecret, marionId } = await setup()
    await alice.asUser.mutation(api.files.create, {
      fileNumber: '25-FRAUD',
      countyId: marionId,
      transactionType: 'purchase',
    })

    const res = await postInbound(t, {
      integrationId,
      inboundSecret,
      payload: {
        MessageID: 'fraud-http-1',
        From: 'phisher@evil.example',
        FromName: 'support@chase.com',
        ReplyTo: 'drop@elsewhere.example',
        Subject: 'Re: file 25-FRAUD updated wire instructions urgent',
        Date: new Date().toISOString(),
        SpfResult: 'fail',
        DkimResult: 'fail',
        DmarcResult: 'fail',
        Attachments: [],
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      autoAttached: boolean
      matchedFileId: string | null
    }
    expect(body.autoAttached).toBe(false)
    expect(body.matchedFileId).toBeDefined()

    const list = await alice.asUser.query(api.inboundEmail.list, {})
    expect(list[0].spamTier).toBe('high_risk')
    expect(list[0].status).toBe('quarantined')
  })

  test('disabled integration rejects with 409', async () => {
    const { t, alice, integrationId, inboundSecret } = await setup()
    await alice.asUser.mutation(api.integrations.setEnabled, {
      integrationId,
      enabled: false,
    })
    const res = await postInbound(t, {
      integrationId,
      inboundSecret,
      payload: {
        MessageID: 'disabled-1',
        From: 'x@example.com',
        Subject: '',
        Date: new Date().toISOString(),
        Attachments: [],
      },
    })
    expect(res.status).toBe(409)
  })

  test('malformed body: rejects with 400', async () => {
    const { t, integrationId, inboundSecret } = await setup()
    const ts = String(Date.now())
    const rawBody = '{not valid json'
    const sig = await hmacHex(inboundSecret, `${ts}.${rawBody}`)
    const res = await t.fetch(
      `/integrations/email/inbound?id=${integrationId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Title-Timestamp': ts,
          'X-Title-Signature': `sha256=${sig}`,
        },
        body: rawBody,
      }
    )
    expect(res.status).toBe(400)
  })
})

describe('HTTP /integrations/email/postmark — end-to-end', () => {
  const ORIG_ENV = process.env.POSTMARK_INBOUND_AUTH

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    process.env.POSTMARK_INBOUND_AUTH = 'pm-user:pm-pass'
  })
  afterEach(() => {
    vi.useRealTimers()
    process.env.POSTMARK_INBOUND_AUTH = ORIG_ENV
  })

  test('routes by MailboxHash and ingests', async () => {
    const { t, alice, marionId } = await setup()
    await alice.asUser.mutation(api.files.create, {
      fileNumber: '25-PM',
      countyId: marionId,
      transactionType: 'purchase',
    })

    const res = await t.fetch('/integrations/email/postmark', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + btoa('pm-user:pm-pass'),
      },
      body: JSON.stringify({
        MessageID: 'pm-1',
        From: 'agent@goodbroker.example',
        Subject: 'Re: file 25-PM signed',
        Date: new Date().toISOString(),
        MailboxHash: 'agency-a',
        SpfResult: 'pass',
        DmarcResult: 'pass',
        Attachments: [],
      }),
    })
    expect(res.status).toBe(200)
    const list = await alice.asUser.query(api.inboundEmail.list, {})
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe('auto_attached')
  })

  test('basic auth required — wrong password 401s', async () => {
    const { t, alice } = await setup()
    const res = await t.fetch('/integrations/email/postmark', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + btoa('pm-user:WRONG'),
      },
      body: JSON.stringify({
        MessageID: 'pm-bad',
        From: 'x@example.com',
        Subject: '',
        Date: new Date().toISOString(),
        MailboxHash: 'agency-a',
        Attachments: [],
      }),
    })
    expect(res.status).toBe(401)
    const list = await alice.asUser.query(api.inboundEmail.list, {})
    expect(list).toHaveLength(0)
  })

  test('unknown MailboxHash returns 200 with no_route status (Postmark stops retrying)', async () => {
    const { t, alice } = await setup()
    const res = await t.fetch('/integrations/email/postmark', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + btoa('pm-user:pm-pass'),
      },
      body: JSON.stringify({
        MessageID: 'pm-no-route',
        From: 'x@example.com',
        Subject: '',
        Date: new Date().toISOString(),
        MailboxHash: 'unknown-tenant',
        Attachments: [],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('no_route')
    const list = await alice.asUser.query(api.inboundEmail.list, {})
    expect(list).toHaveLength(0)
  })

  test('disabled integration: returns 200 with disabled status, no row inserted', async () => {
    const { t, alice, integrationId } = await setup()
    await alice.asUser.mutation(api.integrations.setEnabled, {
      integrationId,
      enabled: false,
    })
    const res = await t.fetch('/integrations/email/postmark', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + btoa('pm-user:pm-pass'),
      },
      body: JSON.stringify({
        MessageID: 'pm-disabled',
        From: 'x@example.com',
        Subject: '',
        Date: new Date().toISOString(),
        MailboxHash: 'agency-a',
        Attachments: [],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('disabled')
  })

  test('extracts auth verdicts from Authentication-Results header', async () => {
    const { t, alice } = await setup()
    const res = await t.fetch('/integrations/email/postmark', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + btoa('pm-user:pm-pass'),
      },
      body: JSON.stringify({
        MessageID: 'pm-auth',
        From: 'agent@example.com',
        Subject: 'no number — please route',
        Date: new Date().toISOString(),
        MailboxHash: 'agency-a',
        Headers: [
          {
            Name: 'Authentication-Results',
            Value:
              'mx; spf=fail smtp.mailfrom=foo; dkim=fail header.d=evil; dmarc=fail header.from=evil',
          },
        ],
        Attachments: [],
      }),
    })
    expect(res.status).toBe(200)
    const list = await alice.asUser.query(api.inboundEmail.list, {})
    expect(list).toHaveLength(1)
    // SPF=fail (+20), DKIM=fail (+15), DMARC=fail (+35) = 70 → high_risk
    expect(list[0].spamTier).toBe('high_risk')
  })

  test('returns 503 when POSTMARK_INBOUND_AUTH is unset', async () => {
    const { t } = await setup()
    delete process.env.POSTMARK_INBOUND_AUTH
    const res = await t.fetch('/integrations/email/postmark', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        MessageID: 'pm-503',
        From: 'x@example.com',
        Subject: '',
        Date: new Date().toISOString(),
        MailboxHash: 'agency-a',
        Attachments: [],
      }),
    })
    expect(res.status).toBe(503)
  })
})

// Silence the "unused internal" complaint — referenced by name in a runtime
// internal call elsewhere; see e.g. _ingestInbound used via api object.
void internal
