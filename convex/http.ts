import { httpRouter } from 'convex/server'
import { internal } from './_generated/api'
import { httpAction } from './_generated/server'
import { authComponent, createAuth } from './auth'
import type { Id } from './_generated/dataModel'

const http = httpRouter()

authComponent.registerRoutes(http, createAuth)

// HMAC-SHA256 of `${timestamp}.${rawBody}`, hex-encoded with the
// integration's `inboundSecret`. We accept "sha256=<hex>" in the
// X-Title-Signature header. Length-checked first, then constant-time-ish
// XOR compare.
async function verifySignature(
  secret: string,
  rawBody: string,
  timestamp: string,
  signatureHeader: string
): Promise<boolean> {
  const expectedPrefix = 'sha256='
  if (!signatureHeader.startsWith(expectedPrefix)) return false
  const provided = signatureHeader.slice(expectedPrefix.length)

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
    new TextEncoder().encode(`${timestamp}.${rawBody}`)
  )
  const computed = Array.from(new Uint8Array(sig), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')

  if (computed.length !== provided.length) return false
  let mismatch = 0
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ provided.charCodeAt(i)
  }
  return mismatch === 0
}

// Common entry: pulls `id` query param + X-Title-* headers, body bytes,
// rejects stale timestamps, looks up the integration, verifies HMAC.
// Returns the verified row or a Response to short-circuit on failure.
async function authenticateAgentRequest(
  ctx: Parameters<Parameters<typeof httpAction>[0]>[0],
  req: Request
): Promise<
  | {
      ok: true
      integrationId: Id<'integrations'>
      tenantId: Id<'tenants'>
      status: 'active' | 'disabled' | 'error'
      rawBody: string
    }
  | { ok: false; response: Response }
> {
  const url = new URL(req.url)
  const integrationIdParam = url.searchParams.get('id')
  const timestamp = req.headers.get('X-Title-Timestamp')
  const signature = req.headers.get('X-Title-Signature')
  if (!integrationIdParam || !timestamp || !signature) {
    return {
      ok: false,
      response: new Response('missing headers', { status: 400 }),
    }
  }
  const rawBody = await req.text()

  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60_000) {
    return {
      ok: false,
      response: new Response('stale timestamp', { status: 400 }),
    }
  }

  const integrationId = integrationIdParam as Id<'integrations'>
  const row = await ctx.runQuery(
    internal.integrations._loadInboundSecretForVerify,
    { integrationId }
  )
  if (!row) {
    return {
      ok: false,
      response: new Response('unauthorized', { status: 401 }),
    }
  }
  const ok = await verifySignature(
    row.inboundSecret,
    rawBody,
    timestamp,
    signature
  )
  if (!ok) {
    return {
      ok: false,
      response: new Response('unauthorized', { status: 401 }),
    }
  }
  return {
    ok: true,
    integrationId,
    tenantId: row.tenantId,
    status: row.status,
    rawBody,
  }
}

// ─── Inbound vendor webhook (pull-mode, e.g. SoftPro 360 push notify) ──
//
// The vendor's system signals "something changed" — we enqueue a sync
// run, the runner pulls. Body shape is opaque to us; the work happens
// inside the adapter.
http.route({
  path: '/integrations/webhook',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const auth = await authenticateAgentRequest(ctx, req)
    if (!auth.ok) return auth.response
    if (auth.status === 'disabled') {
      return new Response('integration disabled', { status: 409 })
    }
    await ctx.runMutation(internal.integrations._enqueueWebhookSync, {
      tenantId: auth.tenantId,
      integrationId: auth.integrationId,
    })
    return new Response('accepted', { status: 202 })
  }),
})

// ─── Agent push: file snapshots ─────────────────────────────────────────
//
// Customer-side agent (SoftPro Standard direct) POSTs a batch of
// FileSnapshots plus an opaque watermark we store and echo back. Body:
//
//   {
//     "snapshots": [FileSnapshot, ...],   // up to 100
//     "watermark": "rowversion:0x000A1B2C" // optional, opaque to us
//   }
//
// Returns 200 on success with `{ runId, filesProcessed, filesUpserted }`
// so the agent can log progress. Returns 4xx on validation/auth issues so
// the agent surfaces them in its own log.
http.route({
  path: '/integrations/agent/sync',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const auth = await authenticateAgentRequest(ctx, req)
    if (!auth.ok) return auth.response
    if (auth.status === 'disabled') {
      return new Response('integration disabled', { status: 409 })
    }

    let body: { snapshots?: unknown; watermark?: unknown }
    try {
      body = JSON.parse(auth.rawBody) as typeof body
    } catch {
      return new Response('invalid json', { status: 400 })
    }
    if (!Array.isArray(body.snapshots)) {
      return new Response('missing snapshots array', { status: 400 })
    }

    try {
      const result = await ctx.runMutation(
        internal.integrations._agentPushSnapshots,
        {
          integrationId: auth.integrationId,
          snapshots: body.snapshots as Array<never>,
          watermark:
            typeof body.watermark === 'string' ? body.watermark : undefined,
        }
      )
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }),
})

// ─── Agent heartbeat ────────────────────────────────────────────────────
//
// Cheap liveness ping. Body:
//
//   {
//     "agentVersion": "0.1.0",
//     "hostname": "DESKTOP-AGENCY-01"
//   }
//
// Server records lastHeartbeatAt + agent metadata. The dashboard uses
// this to render an offline badge if the agent stops checking in.
http.route({
  path: '/integrations/agent/heartbeat',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const auth = await authenticateAgentRequest(ctx, req)
    if (!auth.ok) return auth.response

    let body: { agentVersion?: unknown; hostname?: unknown }
    try {
      body = JSON.parse(auth.rawBody) as typeof body
    } catch {
      return new Response('invalid json', { status: 400 })
    }
    const agentVersion =
      typeof body.agentVersion === 'string' ? body.agentVersion : 'unknown'
    const hostname =
      typeof body.hostname === 'string' ? body.hostname : 'unknown'

    await ctx.runMutation(internal.integrations._agentRecordHeartbeat, {
      integrationId: auth.integrationId,
      agentVersion,
      hostname,
    })
    return new Response(
      JSON.stringify({
        ok: true,
        // Echo server time so the agent can detect clock skew early.
        serverTime: Date.now(),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }),
})

export default http
