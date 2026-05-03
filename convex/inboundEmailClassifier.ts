'use node'

/**
 * Claude-backed soft classifier for inbound email.
 *
 * Layers on top of the deterministic match in inboundEmail._ingestInbound:
 *   • assigns an intent (wire_instructions / payoff / county_response / ...)
 *   • computes a model-derived confidence + a list of human-readable reasons
 *   • optionally suggests a file when the deterministic regex missed but
 *     the email body or attachments make the file obvious
 *
 * Runs out-of-band: a slow or failing model call never blocks the ingest
 * mutation, because that mutation already wrote the row and made the
 * deterministic auto-attach decision.
 *
 * No-API-key path: returns a deterministic stub classification keyed off
 * subject heuristics. The Mail UI shows the same "intent + reasons"
 * surface either way so the demo flow is faithful to production.
 */
import Anthropic from '@anthropic-ai/sdk'
import { ConvexError, v } from 'convex/values'
import { internalAction } from './_generated/server'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'

const ANTHROPIC_MODEL = 'claude-haiku-4-5'

const SYSTEM_PROMPT = `You classify inbound emails arriving at a US title-insurance company. Title companies handle real-estate transaction files (purchase agreements, payoffs, wires, county recordings, lender correspondence). For each email, identify the most likely intent and explain why in 1–4 short reasons.

Output a JSON object with this exact shape, and nothing else:

{
  "intent": "wire_instructions" | "payoff" | "title_commitment" | "closing_disclosure" | "county_response" | "buyer_info" | "lender_correspondence" | "title_document" | "marketing" | "phishing" | "other",
  "confidence": 0-1,                  // your subjective confidence in the intent
  "reasons": string[],                // 1-4 short clauses, plain English, present tense
  "fileNumber": string | null,        // a vendor-style file number you can extract from the email if present (e.g. "ETT-25-001234"), else null
  "fileMatch": {                      // your best guess at which provided candidate file this email is about
    "fileId": string | null,          // pick from candidates[].fileId or null if no good match
    "matchConfidence": 0-1,
    "matchReason": string             // short clause naming what tied it
  }
}

Rules:
- "wire_instructions" requires explicit wire/funding instruction language. Vague "please pay" emails are "lender_correspondence".
- "phishing" requires concrete fraud signals (mismatched sender domain, urgency, payee change without prior context). When in doubt, classify what the email APPEARS to be and surface the fraud risk in reasons.
- "marketing" covers vendor outreach, product pitches, newsletters.
- Reasons must reference observable text from the email, never speculation.
- If the email cites an address that obviously matches a candidate, set fileMatch accordingly.
- Be conservative with confidence: 0.5–0.7 = plausible, 0.7–0.9 = strong, 0.9+ = unambiguous.`

type ClassifierResult = {
  intent: string
  confidence: number
  reasons: string[]
  fileNumber: string | null
  fileMatch: {
    fileId: Id<'files'> | null
    matchConfidence: number
    matchReason: string
  }
}

const KNOWN_INTENTS = new Set([
  'wire_instructions',
  'payoff',
  'title_commitment',
  'closing_disclosure',
  'county_response',
  'buyer_info',
  'lender_correspondence',
  'title_document',
  'marketing',
  'phishing',
  'other',
])

let cachedClient: Anthropic | null = null
function client(): Anthropic | null {
  if (cachedClient) return cachedClient
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  cachedClient = new Anthropic({ apiKey })
  return cachedClient
}

function truncate(s: string | null, n: number): string {
  if (!s) return ''
  const cleaned = s.replace(/\s+/g, ' ').trim()
  return cleaned.length <= n ? cleaned : `${cleaned.slice(0, n - 1)}…`
}

function safeParseJson(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // fall through
    }
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim())
    } catch {
      // fall through
    }
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      // fall through
    }
  }
  return null
}

function clamp01(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function asStringArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((s) => s.trim().slice(0, 200))
    .slice(0, max)
}

function normalizeIntent(s: unknown): string {
  if (typeof s !== 'string') return 'other'
  return KNOWN_INTENTS.has(s) ? s : 'other'
}

// Heuristic fallback used when ANTHROPIC_API_KEY is unset OR the model call
// fails. Keyword-driven and intentionally weak so users notice when the
// real classifier is off.
function heuristicClassify(subject: string, body: string): ClassifierResult {
  const text = `${subject}\n${body}`.toLowerCase()
  const reasons: string[] = []

  let intent = 'other'
  if (/\bwire\b/.test(text) || /payee\s*name/.test(text)) {
    intent = 'wire_instructions'
    reasons.push('subject or body mentions wires')
  } else if (/payoff/.test(text)) {
    intent = 'payoff'
    reasons.push('mentions payoff')
  } else if (/title\s*commitment/.test(text)) {
    intent = 'title_commitment'
    reasons.push('mentions title commitment')
  } else if (/(closing\s*disclosure|settlement\s*statement)/.test(text)) {
    intent = 'closing_disclosure'
    reasons.push('mentions closing disclosure / settlement statement')
  } else if (/(recorded|recording|register\s*of\s*deeds|county\s*clerk)/.test(text)) {
    intent = 'county_response'
    reasons.push('mentions county recording')
  } else if (/lender|loan|mortgage/.test(text)) {
    intent = 'lender_correspondence'
    reasons.push('mentions lender / loan')
  } else if (/unsubscribe|webinar|newsletter|introducing/.test(text)) {
    intent = 'marketing'
    reasons.push('contains marketing language')
  } else if (/(verify|urgent|click\s*here)/.test(text)) {
    intent = 'phishing'
    reasons.push('contains phishing-style urgency words')
  }

  return {
    intent,
    confidence: intent === 'other' ? 0.3 : 0.6,
    reasons: reasons.length > 0 ? reasons : ['heuristic fallback — no API key'],
    fileNumber: null,
    fileMatch: { fileId: null, matchConfidence: 0, matchReason: 'heuristic' },
  }
}

export const run = internalAction({
  args: { inboundEmailId: v.id('inboundEmails') },
  handler: async (ctx, { inboundEmailId }) => {
    const context: {
      tenantId: Id<'tenants'>
      fromAddress: string
      fromName: string | null
      subject: string
      bodyText: string | null
      attachmentCount: number
      spamTier: string | null
      currentMatchedFileId: Id<'files'> | null
      currentConfidence: number
      candidates: Array<{
        fileId: Id<'files'>
        fileNumber: string
        propertyAddress: {
          line1: string
          line2?: string
          city: string
          state: string
          zip: string
        } | null
      }>
    } | null = await ctx.runQuery(
      internal.inboundEmail._loadClassifierContext,
      {
        inboundEmailId,
      }
    )
    if (!context) return null

    const body = truncate(context.bodyText, 4000)
    const subject = truncate(context.subject, 300)
    const candidatesPayload = context.candidates.slice(0, 30).map((c) => ({
      fileId: c.fileId,
      fileNumber: c.fileNumber,
      address: c.propertyAddress
        ? `${c.propertyAddress.line1}, ${c.propertyAddress.city}, ${c.propertyAddress.state} ${c.propertyAddress.zip}`
        : null,
    }))

    let result: ClassifierResult
    let modelId: string | undefined
    const c = client()
    if (!c) {
      result = heuristicClassify(subject, body)
    } else {
      try {
        const userText = [
          `From: ${context.fromName ? `${context.fromName} <${context.fromAddress}>` : context.fromAddress}`,
          `Subject: ${subject}`,
          `Attachments: ${context.attachmentCount}`,
          `Spam tier: ${context.spamTier ?? 'unknown'}`,
          '',
          'Body:',
          body || '(no body text)',
          '',
          'Candidate files (pick fileId from this list or null):',
          JSON.stringify(candidatesPayload, null, 2),
          '',
          'Return the classification JSON now.',
        ].join('\n')

        const response = await c.messages.create({
          model: ANTHROPIC_MODEL,
          max_tokens: 800,
          system: [
            {
              type: 'text',
              text: SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: userText }],
        })
        modelId = response.model
        const textBlock = response.content.find((b) => b.type === 'text')
        const raw =
          textBlock && textBlock.type === 'text' ? textBlock.text : ''
        const parsed = safeParseJson(raw) as Record<string, unknown> | null
        if (!parsed) throw new Error('classifier_no_json')

        const intent = normalizeIntent(parsed.intent)
        const confidence = clamp01(parsed.confidence)
        const reasons = asStringArray(parsed.reasons, 4)
        const fileMatchRaw =
          (parsed.fileMatch as Record<string, unknown> | undefined) ?? {}
        const matchedId =
          typeof fileMatchRaw.fileId === 'string' ? fileMatchRaw.fileId : null
        const validFileId =
          matchedId &&
          context.candidates.some((c) => c.fileId === matchedId)
            ? (matchedId as Id<'files'>)
            : null
        result = {
          intent,
          confidence,
          reasons,
          fileNumber:
            typeof parsed.fileNumber === 'string' ? parsed.fileNumber : null,
          fileMatch: {
            fileId: validFileId,
            matchConfidence: clamp01(fileMatchRaw.matchConfidence),
            matchReason:
              typeof fileMatchRaw.matchReason === 'string'
                ? fileMatchRaw.matchReason.slice(0, 200)
                : '',
          },
        }
      } catch (err) {
        const fallback = heuristicClassify(subject, body)
        fallback.reasons = [
          `model error: ${err instanceof Error ? err.message : String(err)}`,
          ...fallback.reasons,
        ]
        result = fallback
      }
    }

    // Combine signals: classifier confidence floors at the deterministic
    // match's confidence, and the fileId picks the classifier's match if
    // valid, otherwise the existing matched id.
    const finalSuggestedFileId: Id<'files'> | undefined =
      result.fileMatch.fileId ?? context.currentMatchedFileId ?? undefined
    const finalConfidence = Math.max(
      result.confidence * 0.6 +
        result.fileMatch.matchConfidence * 0.4,
      context.currentConfidence
    )

    await ctx.runMutation(internal.inboundEmail._applyClassification, {
      inboundEmailId,
      intent: result.intent as
        | 'wire_instructions'
        | 'payoff'
        | 'title_commitment'
        | 'closing_disclosure'
        | 'county_response'
        | 'buyer_info'
        | 'lender_correspondence'
        | 'title_document'
        | 'marketing'
        | 'phishing'
        | 'other',
      confidence: finalConfidence,
      reasons: result.reasons.length > 0 ? result.reasons : ['no reasoning emitted'],
      suggestedFileId: finalSuggestedFileId,
      modelId,
    })
    return null
  },
})

// Re-classify endpoint (callable from the UI) so processors can rerun the
// model after they fix a sender or after a bad initial pass. Wraps the same
// internal flow but bypasses the "already classified" guard by clearing
// the field first.
export const _rerun = internalAction({
  args: { inboundEmailId: v.id('inboundEmails') },
  handler: async (ctx, { inboundEmailId }) => {
    await ctx.runMutation(internal.inboundEmail._clearClassification, {
      inboundEmailId,
    })
    await ctx.runAction(internal.inboundEmailClassifier.run, {
      inboundEmailId,
    })
    return null
  },
})

// Tiny placeholder so TS doesn't yell about the import being only used in a
// schema-tag — keeps tree-shaking happy on the action runtime.
void ConvexError
