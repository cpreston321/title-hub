'use node'

/**
 * Plain-English risk explainer for reconciliation findings.
 *
 * Junior processors see "wire.payee_partial_match · 67% token overlap" and
 * have to translate that into a real-world action. This action loads the
 * finding + file context (involved docs, peer findings) and asks Claude
 * for two short sentences:
 *   • why this matters here, specifically
 *   • what to do next
 *
 * Triggered by reconciliation.requestExplanation. Output lands on the
 * finding via reconciliation._applyExplanation. Never auto-runs — the
 * processor opts in by clicking "Explain" on a card. No model key → silent
 * no-op so dev / mock flows don't error.
 */
import Anthropic from '@anthropic-ai/sdk'
import { v } from 'convex/values'
import { internalAction } from './_generated/server'
import { internal } from './_generated/api'

const ANTHROPIC_MODEL = 'claude-haiku-4-5'

const SYSTEM_PROMPT = `You help title-insurance processors understand reconciliation findings on a file. Write for a junior employee who is technically literate but not yet senior.

Output a single JSON object with this exact shape, and nothing else:

{
  "why": "one or two sentences explaining what this finding means for THIS file and why it matters before closing",
  "next": "one or two sentences naming the concrete next step (call who, check what, look where) — never speculative"
}

Rules:
- Reference observable details from the finding's rawDetail or involved documents. Do not invent values.
- Avoid jargon: "this is the worst-case wire-fraud pattern" lands better than "BEC pattern detected".
- Where the rawDetail names parties, payees, or amounts, mention them in plain English.
- Do not repeat the finding's existing message verbatim — add interpretation.
- "next" should be a specific action a processor can take in 5 minutes, not "investigate further".
- If the finding type already implies a verification path (phone call, recorder search, etc.), say so explicitly.`

let cachedClient: Anthropic | null = null
function client(): Anthropic | null {
  if (cachedClient) return cachedClient
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  cachedClient = new Anthropic({ apiKey })
  return cachedClient
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

export const explain = internalAction({
  args: { findingId: v.id('reconciliationFindings') },
  handler: async (ctx, { findingId }) => {
    const context: {
      finding: {
        _id: string
        findingType: string
        severity: string
        message: string
        involvedFields: ReadonlyArray<string>
        rawDetail: unknown
      }
      file: {
        fileNumber: string
        transactionType: string
        propertyAddress: {
          line1: string
          line2?: string
          city: string
          state: string
          zip: string
        } | null
        purchasePrice: number | null
      }
      docViews: ReadonlyArray<{
        documentId: string
        docType: string
        title: string | null
        kind: string | null
        summary: string | null
      }>
      peers: ReadonlyArray<{
        findingType: string
        severity: string
        message: string
      }>
    } | null = await ctx.runQuery(
      internal.reconciliation._loadExplainerContext,
      { findingId }
    )
    if (!context) return null

    const c = client()
    let why: string
    let next: string
    let modelId: string | undefined

    if (!c) {
      // Deterministic fallback so dev environments without an API key
      // still produce something. Generic but honest.
      why = `${context.finding.findingType.replace(/_/g, ' ')} on file ${context.file.fileNumber}: ${context.finding.message}`
      next = `Open the file, review the involved documents, and either resolve with the authoritative value or verify by phone with a known contact.`
    } else {
      try {
        const userText = [
          `File: ${context.file.fileNumber} · ${context.file.transactionType}`,
          context.file.propertyAddress
            ? `Property: ${context.file.propertyAddress.line1}, ${context.file.propertyAddress.city}, ${context.file.propertyAddress.state}`
            : 'Property: (not yet set)',
          context.file.purchasePrice
            ? `Reconciled purchase price: $${context.file.purchasePrice.toLocaleString()}`
            : '',
          '',
          `Finding: ${context.finding.findingType} (${context.finding.severity})`,
          `Engine message: ${context.finding.message}`,
          context.finding.involvedFields.length > 0
            ? `Involved fields: ${context.finding.involvedFields.join(', ')}`
            : '',
          'Raw detail:',
          JSON.stringify(context.finding.rawDetail, null, 2),
          '',
          'Involved documents:',
          context.docViews
            .map(
              (d) =>
                `- ${d.title ?? d.docType} (${d.kind ?? d.docType})${d.summary ? ` — ${d.summary}` : ''}`
            )
            .join('\n') || '(none)',
          '',
          'Other open findings on this file:',
          context.peers
            .map((p) => `- ${p.findingType} (${p.severity}): ${p.message}`)
            .join('\n') || '(none)',
          '',
          'Return the explanation JSON now.',
        ]
          .filter(Boolean)
          .join('\n')

        const response = await c.messages.create({
          model: ANTHROPIC_MODEL,
          max_tokens: 600,
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
        const raw = textBlock && textBlock.type === 'text' ? textBlock.text : ''
        const parsed = safeParseJson(raw) as Record<string, unknown> | null
        if (!parsed) throw new Error('explainer_no_json')
        why =
          typeof parsed.why === 'string' && parsed.why.trim()
            ? parsed.why
            : context.finding.message
        next =
          typeof parsed.next === 'string' && parsed.next.trim()
            ? parsed.next
            : 'Review the involved documents and confirm by phone with a known contact.'
      } catch (err) {
        why = `${context.finding.message}`
        next = `Model error generating explanation (${err instanceof Error ? err.message : String(err)}). Try again, or resolve manually.`
      }
    }

    await ctx.runMutation(internal.reconciliation._applyExplanation, {
      findingId,
      why,
      next,
      modelId,
    })
    return null
  },
})
