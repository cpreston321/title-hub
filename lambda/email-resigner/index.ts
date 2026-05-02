/**
 * Email re-signer — reference Lambda
 *
 * Most deployments do NOT need this code path. Postmark Inbound can POST
 * directly to `/integrations/email/postmark` (Basic auth, mailbox-hash
 * routing). Use this Lambda only when:
 *
 *   • Your provider isn't Postmark and doesn't speak Postmark's JSON
 *     shape (e.g. AWS SES + SNS, Mailgun, SendGrid Inbound Parse).
 *   • Your provider can't add Basic auth on the webhook URL.
 *   • You need to enrich or filter inbound mail before it hits the title
 *     hub (e.g. drop calendar invites, strip auto-reply chains).
 *
 * The Lambda translates the provider's JSON into the Postmark-shaped
 * envelope our `/integrations/email/postmark` endpoint already accepts,
 * then forwards it. No HMAC signing needed — Postmark route auths via
 * Basic auth which we set as an env variable on the destination.
 *
 * If you instead need to use the per-integration HMAC route
 * (`/integrations/email/inbound?id=...`), use `forwardWithHmac` below
 * which signs the body with HMAC-SHA256 against the integration's
 * `inboundSecret`.
 *
 * Runtime: Bun, Node 18+, Cloudflare Workers (with Buffer polyfill),
 * or AWS Lambda (Node 20). No npm dependencies required.
 */

interface PostmarkAttachment {
  Name: string
  ContentType: string
  Content: string // base64
  ContentLength: number
}

interface PostmarkEnvelope {
  MessageID: string
  From: string
  FromName?: string
  To: string
  Subject: string
  TextBody?: string
  HtmlBody?: string
  Date: string
  MailboxHash?: string
  OriginalRecipient?: string
  Attachments: ReadonlyArray<PostmarkAttachment>
}

// Env shape — set these on the Lambda runtime.
interface Env {
  /** e.g. https://site-dev-title-convex.cpreston.dev */
  TITLE_HUB_SITE_URL: string
  /** Basic auth pair to authenticate with the Postmark route, e.g. "user:pass". */
  TITLE_HUB_POSTMARK_AUTH: string
}

function envFromGlobal(): Env {
  const e = process.env
  if (!e.TITLE_HUB_SITE_URL) throw new Error('missing TITLE_HUB_SITE_URL')
  if (!e.TITLE_HUB_POSTMARK_AUTH)
    throw new Error('missing TITLE_HUB_POSTMARK_AUTH')
  return {
    TITLE_HUB_SITE_URL: e.TITLE_HUB_SITE_URL,
    TITLE_HUB_POSTMARK_AUTH: e.TITLE_HUB_POSTMARK_AUTH,
  }
}

// ─── Forwarder: Postmark route (recommended) ───────────────────────────
//
// Posts a Postmark-shaped envelope to /integrations/email/postmark with
// Basic auth. Title Hub routes by MailboxHash internally. Use this if you
// can derive a mailbox hash from your provider's payload.

export async function forwardToPostmarkRoute(
  env: Env,
  envelope: PostmarkEnvelope
): Promise<Response> {
  const url = `${env.TITLE_HUB_SITE_URL.replace(/\/+$/, '')}/integrations/email/postmark`
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${btoa(env.TITLE_HUB_POSTMARK_AUTH)}`,
    },
    body: JSON.stringify(envelope),
  })
}

// ─── Forwarder: per-integration HMAC route (alternate) ─────────────────
//
// Posts to /integrations/email/inbound?id=<integrationId> with the
// HMAC scheme used by the simulate-email CLI. Use this only if you've
// pre-resolved the destination integration (e.g. the provider hands you
// metadata that maps 1:1 to a tenant integration in your routing table).

export async function forwardWithHmac(args: {
  siteUrl: string
  integrationId: string
  inboundSecret: string
  envelope: PostmarkEnvelope
}): Promise<Response> {
  const rawBody = JSON.stringify(args.envelope)
  const ts = String(Date.now())
  const sig = await hmacHex(args.inboundSecret, `${ts}.${rawBody}`)
  const url = `${args.siteUrl.replace(/\/+$/, '')}/integrations/email/inbound?id=${args.integrationId}`
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Title-Timestamp': ts,
      'X-Title-Signature': `sha256=${sig}`,
    },
    body: rawBody,
  })
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

// ─── Provider adapters ──────────────────────────────────────────────────
//
// Translate provider JSON shapes into a PostmarkEnvelope. Add adapters
// here as your stack expands. None are mandatory — this is a reference;
// your real Lambda will likely use one.

// AWS SES Lambda invocation via SNS or direct invocation.
// SES emails arrive raw (RFC 822 .eml in S3). We assume an upstream step
// already parsed it into a JSON shape with these fields.
export interface SesParsedMessage {
  messageId: string
  from: { address: string; name?: string }
  to: ReadonlyArray<string>
  subject: string
  text?: string
  html?: string
  date: string
  attachments: ReadonlyArray<{
    filename: string
    contentType: string
    contentBase64: string
    size: number
  }>
}

export function sesToEnvelope(msg: SesParsedMessage): PostmarkEnvelope {
  const recipient = msg.to[0] ?? ''
  const m = recipient.match(/[+-]([^@]+)@/)
  const mailboxHash = m ? m[1] : undefined
  return {
    MessageID: msg.messageId,
    From: msg.from.address,
    FromName: msg.from.name,
    To: recipient,
    OriginalRecipient: recipient,
    MailboxHash: mailboxHash,
    Subject: msg.subject,
    TextBody: msg.text,
    HtmlBody: msg.html,
    Date: msg.date,
    Attachments: msg.attachments.map((a) => ({
      Name: a.filename,
      ContentType: a.contentType,
      Content: a.contentBase64,
      ContentLength: a.size,
    })),
  }
}

// Mailgun store-and-forward webhook payload (form-encoded; pass it through
// formData() upstream and pass the parsed object here).
export interface MailgunPayload {
  'Message-Id': string
  sender: string
  from?: string
  recipient: string
  subject: string
  'body-plain'?: string
  'body-html'?: string
  Date: string
  attachments?: Array<{ name: string; 'content-type': string; data: string; size: number }>
}

export function mailgunToEnvelope(p: MailgunPayload): PostmarkEnvelope {
  const m = p.recipient.match(/[+-]([^@]+)@/)
  const mailboxHash = m ? m[1] : undefined
  return {
    MessageID: p['Message-Id'],
    From: p.sender,
    FromName: p.from && p.from !== p.sender ? p.from : undefined,
    To: p.recipient,
    OriginalRecipient: p.recipient,
    MailboxHash: mailboxHash,
    Subject: p.subject,
    TextBody: p['body-plain'],
    HtmlBody: p['body-html'],
    Date: p.Date,
    Attachments: (p.attachments ?? []).map((a) => ({
      Name: a.name,
      ContentType: a['content-type'],
      Content: a.data,
      ContentLength: a.size,
    })),
  }
}

// ─── AWS Lambda entrypoint (SES via SNS) ───────────────────────────────
//
// Wire this to a Lambda that subscribes to an SNS topic SES publishes
// parsed-mail notifications to. Replace `parseSesRecord` with your real
// parsing path; the AWS SDK has helpers for pulling the .eml from S3.

interface SnsRecord {
  Sns: { Message: string }
}
interface SnsEvent {
  Records: ReadonlyArray<SnsRecord>
}

export async function handler(event: SnsEvent): Promise<{ statusCode: number }> {
  const env = envFromGlobal()
  for (const record of event.Records) {
    const ses = JSON.parse(record.Sns.Message) as SesParsedMessage
    const envelope = sesToEnvelope(ses)
    const res = await forwardToPostmarkRoute(env, envelope)
    if (!res.ok) {
      console.error(
        `forward failed: ${res.status} ${res.statusText} — messageId=${envelope.MessageID}`
      )
    }
  }
  return { statusCode: 200 }
}
