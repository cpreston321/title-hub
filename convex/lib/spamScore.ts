// Authenticity / spam scoring for inbound emails.
//
// The scorer is deterministic: every signal has a documented weight, the
// total is clamped to [0, 100], and the tier falls out of two thresholds.
// We deliberately avoid ML / Claude calls here — the score sits inside an
// audit trail, gates auto-attach, and feeds wire-fraud findings, so we
// need it to be reproducible and explicable to a processor.
//
// Signal taxonomy (positive weights = more spammy):
//   dmarc_fail            +35  hard fraud signal
//   display_name_spoof    +30  fromName contains an email that doesn't match fromAddress
//   reply_to_divergence   +25  Reply-To redirects to a different domain
//   spf_fail              +20  hard auth fail
//   lookalike_punycode    +20  IDN / xn-- domain (homograph-attack vector)
//   dkim_fail             +15  signed but signature invalid
//   auth_missing          +10  no DKIM/SPF/DMARC results at all (rare from real providers)
//   urgency_keywords      +5   "wire today / updated / asap" + attachments
//   reply_chain_only      +5   body is just a quoted chain (BEC re-attach pattern)
//
// Anti-signals (negative weights):
//   dmarc_pass            -15
//   spf_pass              -5
//
// Tier:
//   0..30   → clean
//   31..60  → suspicious
//   61..100 → high_risk

export type SpamTier = 'clean' | 'suspicious' | 'high_risk'

export type SpamSignal = {
  id: string
  label: string
  weight: number
}

export type SpamReport = {
  score: number // 0..100, integer
  tier: SpamTier
  signals: ReadonlyArray<SpamSignal>
}

export type AuthResults = {
  spf?: string // 'pass' | 'fail' | 'softfail' | 'none' | 'neutral' | 'temperror' | 'permerror' | string
  dkim?: string
  dmarc?: string
}

export type SpamInputs = {
  fromAddress: string
  fromName?: string | null
  toAddress?: string | null
  replyToAddress?: string | null
  subject?: string | null
  bodyText?: string | null
  auth?: AuthResults
}

const URGENCY_RE =
  /\b(?:wire (?:today|now|asap)|updated\s+wire|new\s+wire\s+instructions|urgent|asap|immediate(?:ly)?)\b/i

function domainOf(addr: string | null | undefined): string | null {
  if (!addr) return null
  const at = addr.lastIndexOf('@')
  if (at < 0) return null
  return addr.slice(at + 1).trim().toLowerCase()
}

function looksLikeBareEmail(s: string): boolean {
  return /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(s.trim())
}

function isPunycodeDomain(domain: string): boolean {
  // Any label starting with `xn--` is an IDN — most legitimate business
  // mail will not use one, and homograph attacks specifically rely on
  // them. We don't gate on this alone but it contributes weight.
  return domain.split('.').some((l) => l.startsWith('xn--'))
}

// Look at the entire body for any non-quoted text. If everything is
// `> ...` or empty lines, the body is a forwarded-chain shell — a common
// BEC pattern where the attacker just replays the prior thread.
function isQuoteOnly(body: string): boolean {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) return false
  return lines.every((l) => l.startsWith('>'))
}

function pushSignal(
  out: Array<SpamSignal>,
  id: string,
  label: string,
  weight: number
) {
  out.push({ id, label, weight })
}

export function scoreEmail(inputs: SpamInputs): SpamReport {
  const signals: Array<SpamSignal> = []

  const fromDomain = domainOf(inputs.fromAddress)
  const replyToDomain = domainOf(inputs.replyToAddress)

  // ─── Authentication ──────────────────────────────────────────────
  const spf = inputs.auth?.spf?.toLowerCase()
  const dkim = inputs.auth?.dkim?.toLowerCase()
  const dmarc = inputs.auth?.dmarc?.toLowerCase()
  const haveAnyAuth = !!(spf || dkim || dmarc)

  if (dmarc === 'fail') {
    pushSignal(signals, 'dmarc_fail', 'DMARC failed — domain disowns this message', 35)
  } else if (dmarc === 'pass') {
    pushSignal(signals, 'dmarc_pass', 'DMARC passed', -15)
  }

  if (spf === 'fail' || spf === 'permerror') {
    pushSignal(signals, 'spf_fail', `SPF ${spf}`, 20)
  } else if (spf === 'softfail') {
    pushSignal(signals, 'spf_softfail', 'SPF soft-fail', 10)
  } else if (spf === 'pass') {
    pushSignal(signals, 'spf_pass', 'SPF passed', -5)
  }

  if (dkim === 'fail' || dkim === 'permerror') {
    pushSignal(signals, 'dkim_fail', `DKIM ${dkim}`, 15)
  }

  if (!haveAnyAuth) {
    pushSignal(signals, 'auth_missing', 'No DKIM/SPF/DMARC results from provider', 10)
  }

  // ─── Display-name spoof ──────────────────────────────────────────
  // If the FromName contains a literal email address that doesn't match
  // the actual From address, treat it as a brand-impersonation attempt.
  // Common pattern: From: "support@chase.com" <abc123@malicious.example>
  if (inputs.fromName) {
    const m = inputs.fromName.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)
    if (m) {
      const claimed = m[0].toLowerCase()
      if (claimed !== inputs.fromAddress.toLowerCase()) {
        pushSignal(
          signals,
          'display_name_spoof',
          `Display name claims "${m[0]}" but sender is ${inputs.fromAddress}`,
          30
        )
      }
    } else if (looksLikeBareEmail(inputs.fromName)) {
      pushSignal(
        signals,
        'display_name_email',
        'Display name is itself an email address',
        15
      )
    }
  }

  // ─── Reply-To divergence ─────────────────────────────────────────
  if (replyToDomain && fromDomain && replyToDomain !== fromDomain) {
    pushSignal(
      signals,
      'reply_to_divergence',
      `Reply-To routes to ${replyToDomain} (From is ${fromDomain})`,
      25
    )
  }

  // ─── Look-alike / IDN ────────────────────────────────────────────
  if (fromDomain && isPunycodeDomain(fromDomain)) {
    pushSignal(
      signals,
      'lookalike_punycode',
      `Sender domain uses internationalized characters (${fromDomain})`,
      20
    )
  }

  // ─── Body shape signals ──────────────────────────────────────────
  const subject = inputs.subject ?? ''
  const body = inputs.bodyText ?? ''
  if (URGENCY_RE.test(subject) || URGENCY_RE.test(body)) {
    pushSignal(signals, 'urgency_keywords', 'Urgency-style language in subject or body', 5)
  }
  if (body && isQuoteOnly(body)) {
    pushSignal(signals, 'reply_chain_only', 'Body is a quoted reply chain only — no new content', 5)
  }

  // ─── Score + tier ────────────────────────────────────────────────
  const raw = signals.reduce((sum, s) => sum + s.weight, 0)
  const score = Math.max(0, Math.min(100, Math.round(raw)))
  const tier: SpamTier =
    score >= 61 ? 'high_risk' : score >= 31 ? 'suspicious' : 'clean'

  return { score, tier, signals }
}

// ─── Authentication-Results header parsing ─────────────────────────
//
// RFC 8601 header format. Real-world examples vary in punctuation and
// ordering; we want to extract just the spf/dkim/dmarc verdicts. Values
// look like:
//
//   Authentication-Results: postmark.smtpapi.postmarkapp.com;
//     spf=pass smtp.mailfrom=foo@example.com;
//     dkim=pass header.d=example.com;
//     dmarc=pass action=none header.from=example.com
//
// We pull the verdict for each method (the token between `=` and the
// first whitespace or `;`).

export function parseAuthResults(
  headerValue: string | null | undefined
): AuthResults {
  if (!headerValue) return {}
  const out: AuthResults = {}
  const re = /(spf|dkim|dmarc)\s*=\s*([a-z]+)/gi
  for (const m of headerValue.matchAll(re)) {
    const method = m[1].toLowerCase() as 'spf' | 'dkim' | 'dmarc'
    const verdict = m[2].toLowerCase()
    // Only the first verdict per method wins. Some Authentication-Results
    // chains contain multiple DKIM lines — first is usually the primary
    // signing identity.
    if (!out[method]) out[method] = verdict
  }
  return out
}
