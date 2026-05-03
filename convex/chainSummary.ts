'use node'

/**
 * Chain-of-title summary — turns a propertySnapshot's recorded-documents
 * array into a 3-bullet narrative for the operator, plus a list of
 * suspected gaps (a recorded mortgage with no matching release, a recorded
 * deed where the grantor doesn't match the prior grantee, etc.).
 *
 * Triggered by countyConnect.requestChainSummary; writes back via
 * countyConnect._applyChainSummary. No model key → deterministic fallback
 * so dev environments still produce something reasonable.
 */
import Anthropic from '@anthropic-ai/sdk'
import { v } from 'convex/values'
import { internalAction } from './_generated/server'
import { internal } from './_generated/api'

const ANTHROPIC_MODEL = 'claude-haiku-4-5'

const SYSTEM_PROMPT = `You summarize a property's chain of title for a US title-insurance processor.

Input: a list of public-records documents (deeds, mortgages, releases, satisfactions, liens) recorded against a single parcel, plus the current owner from county records and the tax/sale history.

Output a single JSON object with this exact shape, and nothing else:

{
  "bullets": [
    "string",  // 1-4 sentences of plain-English narrative
    "string",
    "string"
  ],
  "missing": [
    "string"   // each gap or unresolved item the processor should chase, 0-6 items
  ]
}

Rules:
- bullets: 2 to 4 items, each 1-2 sentences. Tell the story of how ownership and encumbrances moved over time. Reference dates and parties in plain English.
- missing: name CONCRETE gaps. Examples: "Mortgage to Old National Bank recorded 2018-03-12 has no satisfaction or release on record." Or "Deed to Smith dated 2020-01-04 lists 'John Smith Sr.' but no probate or assumption found tying that to current owner 'John Smith Jr.'"
- If a chain is clean and complete, return missing: [] — don't invent gaps.
- Don't speculate about anything that isn't in the documents list. No legal advice.
- Use ISO dates verbatim from the data. Don't reformat amounts.`

type RecordedDoc = {
  documentType: string
  recordingDate: string | null
  documentNumber: string | null
  bookPage: string | null
  grantor: string | null
  grantee: string | null
  amount: number | null
}

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

function asStringArray(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .slice(0, max)
    .map((s) => s.trim())
}

// Heuristic fallback used when ANTHROPIC_API_KEY is unset OR the model
// call fails. Pairs liens with releases by lender + recording date order
// (same logic the reconciliation comparator uses) so the deterministic
// path still surfaces real gaps.
function heuristicSummary(docs: ReadonlyArray<RecordedDoc>) {
  const bullets: string[] = []
  const missing: string[] = []

  if (docs.length === 0) {
    bullets.push('County recorder returned no documents for this parcel.')
    return { bullets, missing }
  }

  const sorted = [...docs].sort((a, b) =>
    (a.recordingDate ?? '').localeCompare(b.recordingDate ?? '')
  )
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  bullets.push(
    `Earliest recorded instrument: ${first?.documentType ?? 'unknown'}${
      first?.recordingDate ? ` on ${first.recordingDate}` : ''
    }${first?.grantor ? ` from ${first.grantor}` : ''}${
      first?.grantee ? ` to ${first.grantee}` : ''
    }.`
  )
  if (last && last !== first) {
    bullets.push(
      `Most recent: ${last.documentType ?? 'unknown'}${
        last.recordingDate ? ` on ${last.recordingDate}` : ''
      }${last.grantor ? ` from ${last.grantor}` : ''}${
        last.grantee ? ` to ${last.grantee}` : ''
      }.`
    )
  }
  bullets.push(
    `${docs.length} total instrument${docs.length === 1 ? '' : 's'} on record.`
  )

  // Lien / release pairing.
  const isLien = (t: string) =>
    /\b(mortgage|deed of trust|lien|security instrument)\b/i.test(t) &&
    !/\b(release|satisfaction|reconvey)\b/i.test(t)
  const isRelease = (t: string) =>
    /\b(release|satisfaction|reconvey)\b/i.test(t)
  const liens = sorted.filter((d) => isLien(d.documentType))
  const releases = sorted.filter((d) => isRelease(d.documentType))
  const norm = (s: string | null) =>
    (s ?? '')
      .toUpperCase()
      .replace(/[,.&]/g, ' ')
      .replace(/\b(LLC|INC|CORP|CO|N\.A\.|NA|BANK|TRUST|LP|LLP)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  const remaining = [...releases]
  for (const lien of liens) {
    const lender = norm(lien.grantee)
    if (!lender) {
      missing.push(
        `${lien.documentType}${
          lien.recordingDate ? ` recorded ${lien.recordingDate}` : ''
        } — lender name unreadable; satisfy or amend before relying on chain.`
      )
      continue
    }
    const idx = remaining.findIndex((r) => norm(r.grantor) === lender)
    if (idx >= 0) remaining.splice(idx, 1)
    else
      missing.push(
        `No release on record for ${lien.documentType}${
          lien.recordingDate ? ` recorded ${lien.recordingDate}` : ''
        } in favor of ${lien.grantee ?? 'unknown lender'}.`
      )
  }
  return { bullets: bullets.slice(0, 4), missing: missing.slice(0, 6) }
}

export const summarize = internalAction({
  args: { snapshotId: v.id('propertySnapshots') },
  handler: async (ctx, { snapshotId }) => {
    const context: {
      snapshotId: string
      tenantId: string
      property: {
        attomId: string | null
        apn: string | null
        address: { line1: string; city: string; state: string; zip: string }
        owner: { name: string | null; mailingAddress: string | null }
        characteristics: {
          yearBuilt: number | null
          livingAreaSqft: number | null
          lotSizeSqft: number | null
          propertyType: string | null
        }
        lastSale: {
          date: string | null
          price: number | null
          documentType: string | null
        } | null
      } | null
      documents: ReadonlyArray<RecordedDoc>
      tax: {
        taxYear: number | null
        taxAmount: number | null
        assessedValue: number | null
        marketValue: number | null
        taxRateAreaCode: string | null
        exemptions: ReadonlyArray<string>
      } | null
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
      }
    } | null = await ctx.runQuery(
      internal.countyConnect._loadChainContext,
      { snapshotId }
    )
    if (!context) return null

    const c = client()
    let bullets: string[]
    let missing: string[]

    if (!c) {
      const fallback = heuristicSummary(context.documents)
      bullets = fallback.bullets
      missing = fallback.missing
    } else {
      try {
        const userText = [
          `File: ${context.file.fileNumber} · ${context.file.transactionType}`,
          context.file.propertyAddress
            ? `Subject property: ${context.file.propertyAddress.line1}, ${context.file.propertyAddress.city}, ${context.file.propertyAddress.state}`
            : 'Subject property: (not on file yet)',
          context.property?.owner.name
            ? `Current owner of record: ${context.property.owner.name}`
            : 'Current owner of record: (unknown)',
          context.property?.lastSale
            ? `County last-sale: ${context.property.lastSale.date ?? '?'} for ${
                context.property.lastSale.price !== null
                  ? `$${context.property.lastSale.price.toLocaleString()}`
                  : '?'
              } via ${context.property.lastSale.documentType ?? 'unknown'}`
            : '',
          context.tax?.assessedValue
            ? `Assessed value: $${context.tax.assessedValue.toLocaleString()}`
            : '',
          '',
          `Recorded documents (${context.documents.length}):`,
          context.documents.length === 0
            ? '(none returned)'
            : context.documents
                .map(
                  (d) =>
                    `- ${d.recordingDate ?? '????-??-??'} | ${d.documentType}${
                      d.documentNumber ? ` (#${d.documentNumber})` : ''
                    }${d.grantor ? ` | from ${d.grantor}` : ''}${
                      d.grantee ? ` | to ${d.grantee}` : ''
                    }${d.amount !== null ? ` | $${d.amount.toLocaleString()}` : ''}`
                )
                .join('\n'),
          '',
          'Return the summary JSON now.',
        ]
          .filter(Boolean)
          .join('\n')

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
        const textBlock = response.content.find((b) => b.type === 'text')
        const raw = textBlock && textBlock.type === 'text' ? textBlock.text : ''
        const parsed = safeParseJson(raw) as Record<string, unknown> | null
        if (!parsed) throw new Error('chain_summary_no_json')
        bullets = asStringArray(parsed.bullets, 4)
        missing = asStringArray(parsed.missing, 6)
        if (bullets.length === 0) {
          // Don't write an empty narrative — fall back so the row still
          // gets a useful summary on a malformed response.
          const fallback = heuristicSummary(context.documents)
          bullets = fallback.bullets
          if (missing.length === 0) missing = fallback.missing
        }
      } catch {
        const fallback = heuristicSummary(context.documents)
        bullets = fallback.bullets
        missing = fallback.missing
      }
    }

    await ctx.runMutation(internal.countyConnect._applyChainSummary, {
      snapshotId,
      bullets,
      missing,
    })
    return null
  },
})
