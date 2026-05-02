import { httpRouter } from 'convex/server'
import { internal } from './_generated/api'
import { httpAction } from './_generated/server'
import {
  loadBootstrapConfig,
  renderPowerShellScript,
  renderShellScript,
} from './agentBootstrap'
import { authComponent, createAuth } from './auth'
import { parseAuthResults } from './lib/spamScore'
import type { AuthResults } from './lib/spamScore'
import type { Id } from './_generated/dataModel'

const http = httpRouter()

authComponent.registerRoutes(http, createAuth)

// HMAC-SHA256(secret, message), hex-encoded.
async function computeHmacHex(
  secret: string,
  message: string
): Promise<string> {
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

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}

// Verifies a `sha256=<hex>` header against HMAC-SHA256(secret, message).
async function verifyHmacHeader(
  secret: string,
  message: string,
  header: string
): Promise<boolean> {
  const prefix = 'sha256='
  if (!header.startsWith(prefix)) return false
  const provided = header.slice(prefix.length)
  const computed = await computeHmacHex(secret, message)
  return constantTimeEqual(computed, provided)
}

// JSON-body endpoints sign `${timestamp}.${rawBody}`. Document uploads
// have binary bodies + metadata-in-query-params, so they sign a different
// canonical message — see `documentSignedMessage` below.
async function verifySignature(
  secret: string,
  rawBody: string,
  timestamp: string,
  signatureHeader: string
): Promise<boolean> {
  return verifyHmacHeader(secret, `${timestamp}.${rawBody}`, signatureHeader)
}

// Hex SHA-256 of a byte buffer. Used to verify the body of a document
// upload matches the sha256 the agent claimed (and signed).
async function hexSha256(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer to keep crypto.subtle's BufferSource
  // type-narrow (it rejects SharedArrayBuffer-tagged views).
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const buf = await crypto.subtle.digest('SHA-256', copy.buffer)
  return Array.from(new Uint8Array(buf), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
}

// Canonical signed-message format for `/integrations/agent/document`.
// Every field is signed so neither the URL params nor the body can be
// tampered with independently. Pipe is the separator (rather than `.`)
// so a doc title containing a period doesn't break field boundaries.
// Server reconstructs this from the request and compares HMACs.
function documentSignedMessage(parts: {
  timestamp: string
  integrationId: string
  fileNumber: string
  docType: string
  title: string
  sha256: string
}): string {
  return [
    parts.timestamp,
    parts.integrationId,
    parts.fileNumber,
    parts.docType,
    parts.title,
    parts.sha256,
  ].join('|')
}

// Canonical signed-message format for `/integrations/agent/file/exists`.
// No body, so just the metadata pieces.
function fileExistsSignedMessage(parts: {
  timestamp: string
  integrationId: string
  fileNumber: string
}): string {
  return [parts.timestamp, parts.integrationId, parts.fileNumber].join('|')
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

// ─── Agent document upload ──────────────────────────────────────────────
//
// Customer-side agent ships a single document blob. Metadata rides in
// the query string so the server can verify everything before reading
// the (potentially large) body. Wire format:
//
//   POST /integrations/agent/document
//        ?id=<integrationId>
//        &fileNumber=<file number on the integration's tenant>
//        &docType=<purchase_agreement|counter_offer|...>
//        &title=<optional, may be empty>
//        &sha256=<hex>
//   Headers:
//     X-Title-Timestamp: <unix ms>
//     X-Title-Signature: sha256=<hex(HMAC-SHA256(secret, message))>
//   Body: <raw bytes>
//
// where `message` is `documentSignedMessage` over those fields. The
// signature binds every parameter so URL tampering and body tampering
// both fail the verify step. The body's actual sha256 is recomputed and
// must match the param.
//
// Convex's httpAction limit (20 MB body) bounds doc size — the agent
// skips + logs anything larger. That's fine for PA, counter offers,
// lender instructions, ID copies; it'd cap closing packages, but
// closing packages are output, not input to extraction.
http.route({
  path: '/integrations/agent/document',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url)
    const integrationIdParam = url.searchParams.get('id')
    const fileNumber = url.searchParams.get('fileNumber')
    const docType = url.searchParams.get('docType')
    const title = url.searchParams.get('title') ?? ''
    const sha256Claimed = url.searchParams.get('sha256')
    const timestamp = req.headers.get('X-Title-Timestamp')
    const signature = req.headers.get('X-Title-Signature')

    if (
      !integrationIdParam ||
      !fileNumber ||
      !docType ||
      !sha256Claimed ||
      !timestamp ||
      !signature
    ) {
      return new Response('missing required params or headers', { status: 400 })
    }
    const ts = Number(timestamp)
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60_000) {
      return new Response('stale timestamp', { status: 400 })
    }
    if (!/^[a-f0-9]{64}$/.test(sha256Claimed)) {
      return new Response('sha256 must be 64 hex chars', { status: 400 })
    }

    const integrationId = integrationIdParam as Id<'integrations'>
    const row = await ctx.runQuery(
      internal.integrations._loadInboundSecretForVerify,
      { integrationId }
    )
    if (!row) return new Response('unauthorized', { status: 401 })
    if (row.status === 'disabled') {
      return new Response('integration disabled', { status: 409 })
    }

    const message = documentSignedMessage({
      timestamp,
      integrationId,
      fileNumber,
      docType,
      title,
      sha256: sha256Claimed,
    })
    const sigOk = await verifyHmacHeader(row.inboundSecret, message, signature)
    if (!sigOk) return new Response('unauthorized', { status: 401 })

    // Read + verify body. Stale-timestamp + HMAC checks come first so a
    // bogus request short-circuits before paying the body-read cost.
    const bodyBuf = await req.arrayBuffer()
    const bodyBytes = new Uint8Array(bodyBuf)
    if (bodyBytes.byteLength === 0) {
      return new Response('empty body', { status: 400 })
    }
    const sha256Actual = await hexSha256(bodyBytes)
    if (sha256Actual !== sha256Claimed) {
      return new Response(
        JSON.stringify({
          error: 'BODY_SHA256_MISMATCH',
          claimed: sha256Claimed,
          actual: sha256Actual,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Persist the blob first so the mutation only inserts a documents row
    // pointing at an already-stored object. ContentType is best-effort
    // from the request header; the mutation falls back to application/pdf.
    const blob = new Blob([bodyBuf], {
      type: req.headers.get('Content-Type') ?? 'application/octet-stream',
    })
    const storageId = await ctx.storage.store(blob)

    try {
      const result = await ctx.runMutation(
        internal.integrations._uploadAgentDocument,
        {
          integrationId,
          fileNumber,
          docType,
          title: title.length > 0 ? title : undefined,
          sha256: sha256Claimed,
          sizeBytes: bodyBytes.byteLength,
          contentType: req.headers.get('Content-Type') ?? undefined,
          storageId,
        }
      )
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (err) {
      // The mutation cleans up its own storage on the dedup/error paths;
      // here we only need to clean up if the mutation never ran.
      try {
        await ctx.storage.delete(storageId)
      } catch {
        /* best-effort */
      }
      const msg = err instanceof Error ? err.message : String(err)
      const status = /FILE_NOT_FOUND_FOR_DOCUMENT/.test(msg)
        ? 404
        : /INTEGRATION_NOT_FOUND|NOT_PUSH_MODE/.test(msg)
          ? 401
          : /DISABLED/.test(msg)
            ? 409
            : 500
      return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }),
})

// ─── Agent file-exists precheck ─────────────────────────────────────────
//
// Cheap GET the agent calls before shipping a document body. Lets a
// resuming / retrying agent skip the multi-MB upload when the snapshot
// hasn't landed yet, instead of eating the bandwidth and getting a 404
// back. HMAC scheme is the document upload's, minus the body fields.
//
// Wire format:
//
//   GET /integrations/agent/file/exists
//        ?id=<integrationId>
//        &fileNumber=<file number>
//   Headers:
//     X-Title-Timestamp: <unix ms>
//     X-Title-Signature: sha256=<hex(HMAC-SHA256(secret,
//                                  ts|integrationId|fileNumber))>
//
//   200: { "exists": true | false }
//   400: missing params or stale timestamp
//   401: bad signature / unknown integration / pull-mode kind
http.route({
  path: '/integrations/agent/file/exists',
  method: 'GET',
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url)
    const integrationIdParam = url.searchParams.get('id')
    const fileNumber = url.searchParams.get('fileNumber')
    const timestamp = req.headers.get('X-Title-Timestamp')
    const signature = req.headers.get('X-Title-Signature')

    if (!integrationIdParam || !fileNumber || !timestamp || !signature) {
      return new Response('missing required params or headers', { status: 400 })
    }
    const ts = Number(timestamp)
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60_000) {
      return new Response('stale timestamp', { status: 400 })
    }

    const integrationId = integrationIdParam as Id<'integrations'>
    const row = await ctx.runQuery(
      internal.integrations._loadInboundSecretForVerify,
      { integrationId }
    )
    if (!row) return new Response('unauthorized', { status: 401 })

    const message = fileExistsSignedMessage({
      timestamp,
      integrationId,
      fileNumber,
    })
    const sigOk = await verifyHmacHeader(row.inboundSecret, message, signature)
    if (!sigOk) return new Response('unauthorized', { status: 401 })

    try {
      const result = await ctx.runQuery(
        internal.integrations._fileExistsForAgent,
        { integrationId, fileNumber }
      )
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = /NOT_FOUND|NOT_PUSH_MODE/.test(msg) ? 401 : 500
      return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }),
})

// ─── Inbound email (autoscan) ───────────────────────────────────────────
//
// Provider POSTs a Postmark-shaped JSON envelope describing one email plus
// any attachments (base64-encoded). We:
//   1. Verify HMAC on the raw body (provider signs with the integration's
//      `inboundSecret`, identical to the SoftPro agent's auth scheme).
//   2. Persist the JSON as the "raw email" blob for forensics.
//   3. Decode each attachment, compute its sha256, store it as its own blob.
//   4. Call `_ingestInbound`, which classifies + auto-attaches inside one
//      transaction.
//
// Mock-friendly: there's no Postmark-specific signature scheme here.
// Anyone with the inboundSecret (the dev CLI, a Postmark proxy, AWS SES via
// a Lambda shim) can sign and POST. Real Postmark wiring just becomes a
// thin Lambda that re-signs the body with our secret.
//
// Wire format:
//   POST /integrations/email/inbound?id=<integrationId>
//   Headers:
//     X-Title-Timestamp: <unix ms>
//     X-Title-Signature: sha256=<hex(HMAC-SHA256(secret, ts.rawBody))>
//   Body (Postmark-shaped):
//     {
//       "MessageID":   "...",
//       "From":        "agent@example.com",
//       "FromName":    "Jane Agent",
//       "To":          "inbox+tenantslug@title.example.com",
//       "Subject":     "Re: file 25-001234",
//       "TextBody":    "...",
//       "Date":        "2026-05-02T16:30:00Z",
//       "Attachments": [
//         {
//           "Name":          "purchase_agreement.pdf",
//           "ContentType":   "application/pdf",
//           "Content":       "<base64>",
//           "ContentLength": 12345
//         }
//       ]
//     }
//
// Returns:
//   200 { inboundEmailId, autoAttached, matchedFileId, confidence, deduped }
//   400 / 401 / 409 on validation, auth, disabled-integration failures.
//   500 on unexpected failure (an inboundEmails row in `failed` status is
//   inserted so the operator sees it in the inbox UI).

const POSTMARK_MAX_ATTACHMENTS = 50

// Pull SPF/DKIM/DMARC verdicts from a Postmark-shaped payload. Tries the
// explicit `SpfResult` / `DkimResult` / `DmarcResult` convenience fields
// first (used by the simulate-email CLI), then walks the `Headers` array
// looking for `Authentication-Results`. Returns an empty object when
// neither path yields a verdict — the scorer interprets that as
// "auth_missing" and adds a small penalty.
function extractAuthVerdicts(body: {
  Headers?: unknown
  SpfResult?: unknown
  DkimResult?: unknown
  DmarcResult?: unknown
}): AuthResults {
  const explicit: AuthResults = {}
  if (typeof body.SpfResult === 'string' && body.SpfResult)
    explicit.spf = body.SpfResult
  if (typeof body.DkimResult === 'string' && body.DkimResult)
    explicit.dkim = body.DkimResult
  if (typeof body.DmarcResult === 'string' && body.DmarcResult)
    explicit.dmarc = body.DmarcResult
  if (explicit.spf || explicit.dkim || explicit.dmarc) return explicit

  if (!Array.isArray(body.Headers)) return {}
  for (const h of body.Headers) {
    if (
      h &&
      typeof h === 'object' &&
      'Name' in h &&
      'Value' in h &&
      typeof h.Name === 'string' &&
      typeof h.Value === 'string' &&
      h.Name.toLowerCase() === 'authentication-results'
    ) {
      return parseAuthResults(h.Value)
    }
  }
  return {}
}

function decodeBase64ToBytes(b64: string): Uint8Array {
  // atob is available in the Convex runtime (Web platform). Strip whitespace
  // because some providers wrap base64 at column 76.
  const bin = atob(b64.replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

http.route({
  path: '/integrations/email/inbound',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const auth = await authenticateAgentRequest(ctx, req)
    if (!auth.ok) return auth.response
    if (auth.status === 'disabled') {
      return new Response('integration disabled', { status: 409 })
    }

    type Attachment = {
      Name?: unknown
      ContentType?: unknown
      Content?: unknown
      ContentLength?: unknown
    }
    type InboundBody = {
      MessageID?: unknown
      From?: unknown
      FromName?: unknown
      To?: unknown
      ReplyTo?: unknown
      Subject?: unknown
      TextBody?: unknown
      HtmlBody?: unknown
      Date?: unknown
      Attachments?: unknown
      Headers?: unknown
      // Convenience pass-through: callers (the simulate-email CLI) can
      // pre-resolve auth verdicts and skip Headers parsing.
      SpfResult?: unknown
      DkimResult?: unknown
      DmarcResult?: unknown
    }
    let body: InboundBody
    try {
      body = JSON.parse(auth.rawBody) as InboundBody
    } catch {
      return new Response('invalid json', { status: 400 })
    }

    const stringField = (k: keyof InboundBody, fallback = ''): string =>
      typeof body[k] === 'string' ? (body[k] as string) : fallback
    const messageId = stringField('MessageID')
    const fromAddress = stringField('From')
    const subject = stringField('Subject')
    if (!messageId || !fromAddress) {
      return new Response('missing MessageID or From', { status: 400 })
    }
    const fromName = stringField('FromName') || undefined
    const toAddress = stringField('To')
    const replyTo = stringField('ReplyTo') || undefined
    const textBody = stringField('TextBody') || undefined
    const htmlBody = stringField('HtmlBody') || undefined
    const dateStr = stringField('Date')
    const parsedDate = Date.parse(dateStr)
    const receivedAt = Number.isFinite(parsedDate) ? parsedDate : Date.now()

    // Pull authentication verdicts. Prefer caller-supplied SpfResult /
    // DkimResult / DmarcResult fields (used by the simulate-email CLI);
    // fall back to parsing the Authentication-Results header when the
    // provider includes it.
    const authVerdicts = extractAuthVerdicts(body)

    const attachmentsIn = Array.isArray(body.Attachments)
      ? (body.Attachments as Attachment[])
      : []
    if (attachmentsIn.length > POSTMARK_MAX_ATTACHMENTS) {
      // Don't decode — just record the failure so the operator sees it.
      await ctx.runMutation(internal.inboundEmail._markFailed, {
        integrationId: auth.integrationId,
        providerMessageId: messageId,
        fromAddress,
        toAddress,
        subject,
        receivedAt,
        errorMessage: `attachment_count ${attachmentsIn.length} exceeds limit`,
      })
      return new Response(
        JSON.stringify({ error: 'TOO_MANY_ATTACHMENTS' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Persist the raw envelope first. Useful for debugging and for future
    // re-classification — the inboundEmails row points at it via
    // rawStorageId. JSON, not RFC-822, because Postmark already parsed.
    const rawBlob = new Blob([auth.rawBody], { type: 'application/json' })
    let rawStorageId: Id<'_storage'> | undefined
    try {
      rawStorageId = await ctx.storage.store(rawBlob)
    } catch {
      // If we can't store the raw blob, skip it — the email's parsed
      // fields are still on the row, so triage isn't blocked.
      rawStorageId = undefined
    }

    const storedAttachments: Array<{
      filename: string
      contentType: string
      sizeBytes: number
      sha256: string
      storageId: Id<'_storage'>
    }> = []

    const cleanupBlobs = async () => {
      if (rawStorageId) {
        try {
          await ctx.storage.delete(rawStorageId)
        } catch {
          /* best-effort */
        }
      }
      for (const sa of storedAttachments) {
        try {
          await ctx.storage.delete(sa.storageId)
        } catch {
          /* best-effort */
        }
      }
    }

    try {
      for (const a of attachmentsIn) {
        const filename = typeof a.Name === 'string' ? a.Name : 'attachment'
        const contentType =
          typeof a.ContentType === 'string'
            ? a.ContentType
            : 'application/octet-stream'
        const content = typeof a.Content === 'string' ? a.Content : ''
        if (!content) continue
        const bytes = decodeBase64ToBytes(content)
        const sha256 = await hexSha256(bytes)
        const storageId = await ctx.storage.store(
          new Blob([bytes.buffer as ArrayBuffer], { type: contentType })
        )
        storedAttachments.push({
          filename,
          contentType,
          sizeBytes: bytes.byteLength,
          sha256,
          storageId,
        })
      }

      const result = await ctx.runMutation(internal.inboundEmail._ingestInbound, {
        integrationId: auth.integrationId,
        providerMessageId: messageId,
        fromAddress,
        fromName,
        toAddress,
        replyToAddress: replyTo,
        subject,
        bodyText: textBody,
        bodyHtml: htmlBody,
        receivedAt,
        rawStorageId,
        attachments: storedAttachments,
        spfResult: authVerdicts.spf,
        dkimResult: authVerdicts.dkim,
        dmarcResult: authVerdicts.dmarc,
      })

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (err) {
      // Mutation threw — clean up blobs we already stored, then record a
      // failure row so the operator sees it.
      await cleanupBlobs()
      const msg = err instanceof Error ? err.message : String(err)
      try {
        await ctx.runMutation(internal.inboundEmail._markFailed, {
          integrationId: auth.integrationId,
          providerMessageId: messageId,
          fromAddress,
          toAddress,
          subject,
          receivedAt,
          errorMessage: msg,
        })
      } catch {
        /* best-effort */
      }
      const status = /TOO_MANY_ATTACHMENTS|INTEGRATION_NOT_EMAIL/.test(msg)
        ? 400
        : /INTEGRATION_NOT_FOUND|INTEGRATION_DISABLED/.test(msg)
          ? 409
          : 500
      return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }),
})

// ─── Postmark inbound webhook ──────────────────────────────────────────
//
// Postmark Inbound (https://postmarkapp.com/developer/user-guide/inbound)
// POSTs a single JSON envelope per delivered email to a configured URL.
// We accept that envelope here, route by `MailboxHash` (the `+suffix`
// portion of the recipient address — Postmark surfaces it as a separate
// field), and call the same `_ingestInbound` mutation the per-integration
// HMAC path uses.
//
// Auth: Postmark supports HTTP Basic auth on the webhook URL. Configure
// the user/password in Postmark's UI, set the same value in Convex env
// (`POSTMARK_INBOUND_AUTH=user:pass`), and we compare in constant time.
// If `POSTMARK_INBOUND_AUTH` is not set the route returns 503 — there is
// no anonymous mode, ever.
//
// Returns 200 on:
//   - successful ingest (autoAttached or quarantined)
//   - duplicate delivery (Postmark retried)
//   - unrouteable email (no matching email_inbound integration)
// We always return 200 so Postmark stops retrying — the tenant routing
// failure is logged on the server side. 4xx is reserved for malformed
// payloads (Postmark won't retry forever on those).

function constantTimeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}

http.route({
  path: '/integrations/email/postmark',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const expected = process.env.POSTMARK_INBOUND_AUTH
    if (!expected) {
      return new Response('postmark inbound not configured', { status: 503 })
    }

    const authHeader = req.headers.get('Authorization') ?? ''
    if (!authHeader.startsWith('Basic ')) {
      return new Response('unauthorized', { status: 401 })
    }
    let provided: string
    try {
      provided = atob(authHeader.slice('Basic '.length))
    } catch {
      return new Response('unauthorized', { status: 401 })
    }
    if (!constantTimeEqualStr(provided, expected)) {
      return new Response('unauthorized', { status: 401 })
    }

    type PostmarkAttachment = {
      Name?: unknown
      ContentType?: unknown
      Content?: unknown
      ContentLength?: unknown
    }
    type PostmarkBody = {
      MessageID?: unknown
      From?: unknown
      FromName?: unknown
      To?: unknown
      ReplyTo?: unknown
      OriginalRecipient?: unknown
      MailboxHash?: unknown
      Subject?: unknown
      TextBody?: unknown
      HtmlBody?: unknown
      Date?: unknown
      Attachments?: unknown
      Headers?: unknown
      SpfResult?: unknown
      DkimResult?: unknown
      DmarcResult?: unknown
    }
    const rawBody = await req.text()
    let body: PostmarkBody
    try {
      body = JSON.parse(rawBody) as PostmarkBody
    } catch {
      return new Response('invalid json', { status: 400 })
    }

    const stringField = (k: keyof PostmarkBody): string => {
      const val = body[k]
      return typeof val === 'string' ? val : ''
    }
    const messageId = stringField('MessageID')
    const fromAddress = stringField('From')
    if (!messageId || !fromAddress) {
      return new Response('missing MessageID or From', { status: 400 })
    }

    // MailboxHash is Postmark's surfaced "+suffix" — e.g. an email to
    // `webhook+abc123@inbound.postmarkapp.com` arrives with
    // `MailboxHash: "abc123"`. Fall back to parsing OriginalRecipient if
    // for any reason the field is empty.
    let localpart = stringField('MailboxHash')
    if (!localpart) {
      const orig = stringField('OriginalRecipient') || stringField('To')
      const m = orig.match(/[+-]([^@]+)@/)
      if (m) localpart = m[1]
    }
    if (!localpart) {
      // Unrouteable. Return 200 so Postmark stops retrying; the operator
      // can investigate via Postmark's "delivered to webhook" tab.
      return new Response(
        JSON.stringify({ status: 'no_mailbox_hash' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const route = await ctx.runQuery(
      internal.inboundEmail._findEmailInboundByLocalpart,
      { localpart }
    )
    if (!route) {
      return new Response(
        JSON.stringify({ status: 'no_route', localpart }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }
    if (route.status === 'disabled') {
      return new Response(
        JSON.stringify({ status: 'disabled', localpart }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const fromName = stringField('FromName') || undefined
    const toAddress = stringField('To')
    const replyTo = stringField('ReplyTo') || undefined
    const subject = stringField('Subject')
    const textBody = stringField('TextBody') || undefined
    const htmlBody = stringField('HtmlBody') || undefined
    const dateStr = stringField('Date')
    const parsedDate = Date.parse(dateStr)
    const receivedAt = Number.isFinite(parsedDate) ? parsedDate : Date.now()
    const authVerdicts = extractAuthVerdicts(body)

    const attachmentsIn = Array.isArray(body.Attachments)
      ? (body.Attachments as Array<PostmarkAttachment>)
      : []
    if (attachmentsIn.length > POSTMARK_MAX_ATTACHMENTS) {
      await ctx.runMutation(internal.inboundEmail._markFailed, {
        integrationId: route.integrationId,
        providerMessageId: messageId,
        fromAddress,
        toAddress,
        subject,
        receivedAt,
        errorMessage: `attachment_count ${attachmentsIn.length} exceeds limit`,
      })
      return new Response(
        JSON.stringify({ status: 'too_many_attachments' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const rawBlob = new Blob([rawBody], { type: 'application/json' })
    let rawStorageId: Id<'_storage'> | undefined
    try {
      rawStorageId = await ctx.storage.store(rawBlob)
    } catch {
      rawStorageId = undefined
    }

    const storedAttachments: Array<{
      filename: string
      contentType: string
      sizeBytes: number
      sha256: string
      storageId: Id<'_storage'>
    }> = []

    const cleanupBlobs = async () => {
      if (rawStorageId) {
        try {
          await ctx.storage.delete(rawStorageId)
        } catch {
          /* best-effort */
        }
      }
      for (const sa of storedAttachments) {
        try {
          await ctx.storage.delete(sa.storageId)
        } catch {
          /* best-effort */
        }
      }
    }

    try {
      for (const a of attachmentsIn) {
        const filename = typeof a.Name === 'string' ? a.Name : 'attachment'
        const contentType =
          typeof a.ContentType === 'string'
            ? a.ContentType
            : 'application/octet-stream'
        const content = typeof a.Content === 'string' ? a.Content : ''
        if (!content) continue
        const bytes = decodeBase64ToBytes(content)
        const sha256 = await hexSha256(bytes)
        const storageId = await ctx.storage.store(
          new Blob([bytes.buffer as ArrayBuffer], { type: contentType })
        )
        storedAttachments.push({
          filename,
          contentType,
          sizeBytes: bytes.byteLength,
          sha256,
          storageId,
        })
      }

      const result = await ctx.runMutation(
        internal.inboundEmail._ingestInbound,
        {
          integrationId: route.integrationId,
          providerMessageId: messageId,
          fromAddress,
          fromName,
          toAddress,
          replyToAddress: replyTo,
          subject,
          bodyText: textBody,
          bodyHtml: htmlBody,
          receivedAt,
          rawStorageId,
          attachments: storedAttachments,
          spfResult: authVerdicts.spf,
          dkimResult: authVerdicts.dkim,
          dmarcResult: authVerdicts.dmarc,
        }
      )
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (err) {
      await cleanupBlobs()
      const msg = err instanceof Error ? err.message : String(err)
      try {
        await ctx.runMutation(internal.inboundEmail._markFailed, {
          integrationId: route.integrationId,
          providerMessageId: messageId,
          fromAddress,
          toAddress,
          subject,
          receivedAt,
          errorMessage: msg,
        })
      } catch {
        /* best-effort */
      }
      // Still 200 — we've recorded the failure server-side; we don't want
      // Postmark hammering us with retries on a payload-shape issue.
      return new Response(
        JSON.stringify({ status: 'failed', error: msg }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }
  }),
})

// ─── Agent install-token redemption ─────────────────────────────────────
//
// Called once per agent install. Body: `{ "token": "<64-hex>" }`. Trades a
// short-lived install token (issued by an admin in the web UI via
// `integrations.generateAgentInstallToken`) for the long-lived inbound
// secret + integration id. No HMAC — the token itself is the credential,
// and it's single-use + 15-min TTL.
http.route({
  path: '/integrations/agent/redeem',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    let body: { token?: unknown }
    try {
      body = (await req.json()) as { token?: unknown }
    } catch {
      return new Response('invalid json', { status: 400 })
    }
    const token = typeof body.token === 'string' ? body.token : ''
    if (!token) {
      return new Response('missing token', { status: 400 })
    }

    // Best-effort source-IP capture for the audit row. CDNs / proxies put
    // the original IP in x-forwarded-for; trust the first entry there.
    const fromIp =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip') ||
      undefined

    try {
      const result = (await ctx.runMutation(
        internal.integrations._redeemAgentInstallToken,
        { token, fromIp }
      )) as { integrationId: Id<'integrations'>; inboundSecret: string }
      // The agent already knows the base URL (it just made this request);
      // we don't need to echo it back.
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Map ConvexError messages onto sensible HTTP statuses so the agent
      // can give a precise hint without parsing prose.
      const status = /MALFORMED|missing/i.test(msg)
        ? 400
        : /NOT_FOUND|EXPIRED|ALREADY_USED|DISABLED|NOT_PUSH_MODE/i.test(msg)
          ? 401
          : 500
      return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }),
})

// ─── Agent bootstrap script ─────────────────────────────────────────────
//
// `iwr https://...convex.site/agent/install.ps1?t=<TOKEN> | iex`
// `curl -fsSL https://...convex.site/agent/install.sh?t=<TOKEN> | bash`
//
// Returns a platform-specific install script that downloads the agent
// release archive (configured via AGENT_RELEASE_BASE_URL +
// AGENT_RELEASE_VERSION), verifies its SHA-256, extracts, and runs
// `agent install` to redeem the token. The token here is identified
// via query string so the URL itself is the credential — short-lived
// (15 min) and single-use, exactly like the bare `agent install` flow.
function bootstrapHandler(kind: 'ps1' | 'sh') {
  return httpAction(async (ctx, req) => {
    const url = new URL(req.url)
    const token = url.searchParams.get('t') ?? url.searchParams.get('token') ?? ''
    if (!token) {
      return new Response(
        '# missing token: include ?t=<install-token> in the bootstrap URL',
        { status: 400, headers: { 'Content-Type': 'text/plain' } }
      )
    }

    // Pre-validate without consuming so a stale URL fails fast — the
    // user's terminal prints a clear hint instead of downloading 30 MB
    // of binary that then fails at the redeem step.
    try {
      await ctx.runQuery(internal.integrations._validateAgentInstallToken, {
        token,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const hint = /EXPIRED/.test(msg)
        ? 'The install token has expired (15-min TTL). Generate a new one in the admin UI.'
        : /ALREADY_USED/.test(msg)
          ? 'This install token has already been used. Generate a fresh one if you need to reinstall.'
          : /NOT_FOUND/.test(msg)
            ? 'The server does not recognize this install token. Re-copy the bootstrap URL from the admin UI.'
            : /MALFORMED/.test(msg)
              ? 'The token in the URL is not a 64-char hex string.'
              : msg
      const comment = kind === 'ps1' ? '#' : '#'
      return new Response(
        `${comment} bootstrap rejected: ${msg}\n${comment} ${hint}\n`,
        { status: 401, headers: { 'Content-Type': 'text/plain' } }
      )
    }

    let cfg
    try {
      cfg = loadBootstrapConfig(`${url.protocol}//${url.host}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return new Response(`# bootstrap not configured: ${msg}\n`, {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    const body =
      kind === 'ps1'
        ? renderPowerShellScript(cfg, token)
        : renderShellScript(cfg, token)
    const contentType =
      kind === 'ps1'
        ? 'application/x-powershell; charset=utf-8'
        : 'text/x-shellscript; charset=utf-8'
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        // Short cache window so a regenerated token doesn't get stuck
        // behind a CDN. The token TTL is 15 min anyway.
        'Cache-Control': 'no-store',
      },
    })
  })
}

http.route({
  path: '/agent/install.ps1',
  method: 'GET',
  handler: bootstrapHandler('ps1'),
})

http.route({
  path: '/agent/install.sh',
  method: 'GET',
  handler: bootstrapHandler('sh'),
})

export default http
