#!/usr/bin/env bun
/**
 * Resend Inbound auth-fidelity probe ─────────────────────── Verifies whether
 * Resend Inbound forwards the email-authentication headers the disbursement
 * guardrail's `emailSource` check needs (Authentication-Results, Received-SPF,
 * DKIM-Signature). Inspect a specific email by id, or list the latest 5.
 *
 *   Usage:
 *     RESEND_API_KEY=re_... bun run scripts/check-resend-inbound.ts            # list latest 5
 *     RESEND_API_KEY=re_... bun run scripts/check-resend-inbound.ts <email_id>
 *
 * To answer the open question: send a test email to your receiving domain
 * (any sender — gmail.com is fine, it'll add Authentication-Results), then
 * run this script with the resulting id.
 */
import { Resend } from 'resend'

const KEY = process.env.RESEND_API_KEY
if (!KEY) {
  console.error('RESEND_API_KEY not set.')
  process.exit(1)
}
const resend = new Resend(KEY)
const id = process.argv[2]

if (!id) {
  const list = await resend.emails.receiving.list({ limit: 5 })
  if (list.error) throw new Error(list.error.message)
  const rows = list.data?.data ?? []
  if (rows.length === 0) {
    console.log('No inbound emails found. Send one to your receiving domain and retry.')
    process.exit(0)
  }
  console.log('Latest inbound emails (pass an id to inspect):\n')
  for (const r of rows) {
    console.log(`  ${r.id}  ${r.created_at}  from=${r.from}  subject=${r.subject?.slice(0, 60) ?? ''}`)
  }
  process.exit(0)
}

const got = await resend.emails.receiving.get(id)
if (got.error) throw new Error(got.error.message)
const e = got.data!

const headers = e.headers ?? {}
const headerKeys = Object.keys(headers)
const auth = {
  authResults:        findHeader(headers, 'authentication-results'),
  receivedSpf:        findHeader(headers, 'received-spf'),
  dkimSignature:      findHeader(headers, 'dkim-signature'),
  arcAuthResults:     findHeader(headers, 'arc-authentication-results'),
  arcMessageSig:      findHeader(headers, 'arc-message-signature'),
}

console.log(`\n── Email ${e.id} ─────────────────────────────────────`)
console.log(`From:     ${e.from}`)
console.log(`Subject:  ${e.subject}`)
console.log(`Created:  ${e.created_at}`)
console.log(`MessageId: ${e.message_id}`)
console.log(`Attachments: ${e.attachments.length}`)
console.log(`\n── Headers (${headerKeys.length} total) ────────────────`)
if (headerKeys.length === 0) {
  console.log('  (none — `headers` is null/empty)')
} else {
  for (const k of headerKeys.sort()) console.log(`  ${k}: ${truncate(headers[k], 200)}`)
}

console.log(`\n── Auth-relevant headers ─────────────────────────────`)
console.log(`  Authentication-Results:     ${present(auth.authResults)}`)
console.log(`  Received-SPF:               ${present(auth.receivedSpf)}`)
console.log(`  DKIM-Signature:             ${present(auth.dkimSignature)}`)
console.log(`  ARC-Authentication-Results: ${present(auth.arcAuthResults)}`)
console.log(`  ARC-Message-Signature:      ${present(auth.arcMessageSig)}`)

console.log(`\n── Verdict ───────────────────────────────────────────`)
if (auth.authResults) {
  console.log('  ✓ Authentication-Results present in `headers`. Existing extractAuthVerdicts()')
  console.log('    will work directly — no raw-MIME fallback needed.')
} else if (e.raw?.download_url) {
  console.log('  ⚠ No Authentication-Results in `headers`, but `raw` MIME is downloadable.')
  console.log(`    Fallback: fetch ${e.raw.download_url}`)
  console.log('    and parse Authentication-Results out of the RFC-822 head before forwarding.')
  console.log('    Adds a fourth network call per inbound email but unblocks the guardrail.')
} else {
  console.log('  ✗ No Authentication-Results header AND no raw MIME URL.')
  console.log('    The disbursement guardrail emailSource check would lose SPF/DKIM signal.')
  console.log('    Recommendation: do not migrate inbound to Resend until they expose this.')
}

function findHeader(h: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase()
  for (const k of Object.keys(h)) if (k.toLowerCase() === want) return h[k]
  return undefined
}
function present(v: string | undefined): string {
  return v ? `✓  ${truncate(v, 140)}` : '— not present'
}
function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…'
}
