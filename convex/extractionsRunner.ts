"use node"

import Anthropic from "@anthropic-ai/sdk"
import { v } from "convex/values"
import { internalAction } from "./_generated/server"
import { internal } from "./_generated/api"

// ─────────────────────────────────────────────────────────────────────
// Prompt + parser
// ─────────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = "v2"

const SYSTEM_PROMPT = `You extract structured fields from US real-estate transaction documents: purchase agreements, counter offers, title commitments, title search reports, closing disclosures, deeds, and seller's disclosures.

Read the document and emit a single JSON object matching the schema below. Output ONLY the JSON object — no prose, no markdown fences, no commentary before or after.

Schema:
{
  "documentKind": "purchase_agreement" | "counter_offer" | "title_search" | "commitment" | "closing_disclosure" | "deed" | "sellers_disclosure" | "other",
  "parties": Array<{
    "role": "buyer" | "seller" | "lender" | "borrower" | "trustee" | "signer" | "broker" | "title_company" | "escrow_agent" | "other",
    "legalName": string,
    "capacity"?: string  // e.g. "AIF" (attorney-in-fact), "trustee of the X trust", "successor trustee"
  }>,
  "property": {
    "address"?: string,
    "legalDescription"?: string,
    "parcelId"?: string,
    "county"?: string,
    "state"?: string,
    "zip"?: string
  } | null,
  "financial": {
    "purchasePrice"?: number,         // USD, no symbols, no commas
    "earnestMoney"?: { "amount"?: number, "refundable"?: boolean, "depositDays"?: number },
    "sellerConcessions"?: number,
    "buyerBrokerCompensation"?: { "amount"?: number, "percent"?: number, "paidBy"?: "buyer" | "seller" }
  } | null,
  "dates": {
    "effectiveDate"?: string,         // ISO 8601 (YYYY-MM-DD)
    "closingDate"?: string,
    "financingApprovalDays"?: number, // days after acceptance
    "expirationOfOffer"?: string
  } | null,
  "titleCompany": {
    "name"?: string,
    "phone"?: string,
    "selectedBy"?: "buyer" | "seller" | "shared"
  } | null,
  "contingencies": string[],          // freeform tags: "appraisal", "inspection", "sale_of_buyer_property", "financing"
  "amendments": string[],             // for counter offers: each modification as a one-line summary
  "notes": string[],                  // important things you noticed that don't fit elsewhere
  "_confidence"?: {                   // optional 0..1 confidence per field path; omit when fully confident
    [fieldPath: string]: number       // e.g. "financial.purchasePrice", "titleCompany.name", "parties[0].legalName", "dates.closingDate"
  }
}

Conventions:
- Use null for whole sections not present (e.g. a deed with no financial section). Use undefined keys for missing sub-fields, not empty strings.
- Numbers must be plain numbers — no "$", no commas, no quotes around them.
- Dates must be ISO 8601 (YYYY-MM-DD).
- If a counter offer modifies a price, capture the NEW price in financial.purchasePrice and describe the change as one bullet in amendments.
- People with a signing capacity ("Rene S Kotter, AIF") → legalName: "Rene S Kotter", capacity: "AIF".
- If the title company is named in any document (purchase agreement OR counter offer), capture it under titleCompany.
- Do not invent values. If you cannot read a field with confidence, omit it.
- _confidence: only emit entries for fields where you are NOT fully confident (< 0.95). Use 0.5–0.7 when the field is partially obscured, ambiguous, or relies on inference. Use 0.7–0.9 when readable but with minor uncertainty (e.g. handwritten amendments). Omit any field path you read with full confidence — a missing entry means 1.0.`

export type ExtractionPayload = {
  documentKind: string
  parties: Array<{
    role: string
    legalName: string
    capacity?: string
  }>
  property: {
    address?: string
    legalDescription?: string
    parcelId?: string
    county?: string
    state?: string
    zip?: string
  } | null
  financial: {
    purchasePrice?: number
    earnestMoney?: {
      amount?: number
      refundable?: boolean
      depositDays?: number
    }
    sellerConcessions?: number
    buyerBrokerCompensation?: {
      amount?: number
      percent?: number
      paidBy?: string
    }
  } | null
  dates: {
    effectiveDate?: string
    closingDate?: string
    financingApprovalDays?: number
    expirationOfOffer?: string
  } | null
  titleCompany: { name?: string; phone?: string; selectedBy?: string } | null
  contingencies: string[]
  amendments: string[]
  notes: string[]
  // Optional 0..1 confidence map keyed by field path.
  // Missing entry ⇒ treated as 1.0.
  _confidence?: Record<string, number>
}

export function parseExtractionJson(raw: string): ExtractionPayload {
  const trimmed = raw.trim()

  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as ExtractionPayload
    } catch {
      // fall through
    }
  }

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence && fence[1]) {
    try {
      return JSON.parse(fence[1].trim()) as ExtractionPayload
    } catch {
      // fall through
    }
  }

  const start = trimmed.indexOf("{")
  if (start >= 0) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === "\\") escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          return JSON.parse(trimmed.slice(start, i + 1)) as ExtractionPayload
        }
      }
    }
  }

  throw new Error("EXTRACTION_NO_JSON")
}

// ─────────────────────────────────────────────────────────────────────
// Mock extraction (when ANTHROPIC_API_KEY is unset)
// ─────────────────────────────────────────────────────────────────────

const MOCK_BY_DOCTYPE: Record<string, ExtractionPayload> = {
  purchase_agreement: {
    documentKind: "purchase_agreement",
    parties: [
      { role: "buyer", legalName: "Michelle Hicks" },
      { role: "seller", legalName: "Rene S Kotter", capacity: "AIF" },
    ],
    property: {
      address: "3324 Corey Dr, Indianapolis, IN 46227",
      legalDescription: "Holly Heights L68",
      parcelId: "491517124083000500",
      county: "Marion",
      state: "IN",
      zip: "46227",
    },
    financial: {
      purchasePrice: 225000,
      earnestMoney: { amount: 500, refundable: true, depositDays: 2 },
      sellerConcessions: 3200,
      buyerBrokerCompensation: { percent: 3, paidBy: "seller" },
    },
    dates: {
      effectiveDate: "2026-02-02",
      closingDate: "2026-03-04",
      financingApprovalDays: 40,
      expirationOfOffer: "2026-02-03",
    },
    titleCompany: { name: "Near North Title", selectedBy: "buyer" },
    contingencies: ["financing", "inspection", "appraisal", "homeowners_insurance"],
    amendments: [],
    notes: [
      "Seller agrees to a $5,500 contractor check at closing payable to RiteRug Flooring.",
      "Surveyor location report at seller's expense.",
    ],
    _confidence: {
      "financial.earnestMoney.refundable": 0.7,
      "parties[1].capacity": 0.8,
    },
  },
  counter_offer: {
    documentKind: "counter_offer",
    parties: [
      { role: "buyer", legalName: "Michelle Hicks" },
      { role: "seller", legalName: "Rene S Kotter", capacity: "AIF" },
    ],
    property: {
      address: "3324 Corey Dr, Indianapolis, IN 46227",
      county: "Marion",
      state: "IN",
    },
    financial: {
      purchasePrice: 233600,
      earnestMoney: { refundable: false },
    },
    dates: {
      effectiveDate: "2026-02-03",
      closingDate: "2026-03-04",
      financingApprovalDays: 25,
    },
    titleCompany: {
      name: "Quality Title Insurance",
      phone: "317-780-5700",
      selectedBy: "seller",
    },
    contingencies: ["financing", "inspection"],
    amendments: [
      "Purchase price raised to $233,600 (from $225,000).",
      "Earnest money is non-refundable.",
      "Financing approval deadline reduced to 25 days after acceptance.",
      "Seller selects title company: Quality Title Insurance.",
      "Seller transfers existing American Home Shield warranty to buyer at closing.",
      "Survey, if requested, ordered and paid for by buyer.",
      "Seller not required to make any single repair under $500.",
    ],
    notes: [
      "BIR #1 response window: 48 hours after written proof of lender loan conditions.",
    ],
    _confidence: {
      "financial.purchasePrice": 0.9,
      "financial.earnestMoney.refundable": 0.65,
      "titleCompany.name": 0.85,
      "dates.financingApprovalDays": 0.75,
    },
  },
}

function mockExtraction(docTypeHint?: string): ExtractionPayload {
  if (docTypeHint && MOCK_BY_DOCTYPE[docTypeHint]) {
    return MOCK_BY_DOCTYPE[docTypeHint]
  }
  return {
    documentKind: "other",
    parties: [],
    property: null,
    financial: null,
    dates: null,
    titleCompany: null,
    contingencies: [],
    amendments: [],
    notes: [],
  }
}

// ─────────────────────────────────────────────────────────────────────
// Action: extractFromPdf
// ─────────────────────────────────────────────────────────────────────

let cachedClient: Anthropic | null = null
function client(): Anthropic | null {
  if (cachedClient) return cachedClient
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  cachedClient = new Anthropic({ apiKey })
  return cachedClient
}

const ANTHROPIC_MODEL = "claude-haiku-4-5"

// Single-action job: load bytes from _storage, base64 in-action, call
// Anthropic, persist. Doing everything in one action means the PDF bytes
// never cross an action boundary — Convex caps Node action arguments at
// 5 MiB and base64'd PDFs blow past that on title searches and similar
// large documents.
export const runJob = internalAction({
  args: {
    extractionId: v.id("documentExtractions"),
    storageId: v.id("_storage"),
    docTypeHint: v.optional(v.string()),
  },
  handler: async (ctx, { extractionId, storageId, docTypeHint }) => {
    await ctx.runMutation(internal.extractions.markRunning, { extractionId })
    try {
      const blob = await ctx.storage.get(storageId)
      if (!blob) throw new Error("STORAGE_NOT_FOUND")
      const bytes = await blob.arrayBuffer()
      const base64 = Buffer.from(bytes).toString("base64")

      const c = client()
      let payload: ExtractionPayload
      let modelId: string
      let source: "claude" | "mock"

      if (!c) {
        payload = mockExtraction(docTypeHint)
        modelId = "mock"
        source = "mock"
      } else {
        const userText = docTypeHint
          ? `The user has classified this document as: ${docTypeHint}. Verify and extract per schema. Return JSON only.`
          : `Extract per the schema. Return JSON only.`

        const response = await c.messages.create({
          model: ANTHROPIC_MODEL,
          max_tokens: 4096,
          system: [
            {
              type: "text",
              text: `Schema version: ${SCHEMA_VERSION}\n\n${SYSTEM_PROMPT}`,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: base64,
                  },
                },
                { type: "text", text: userText },
              ],
            },
          ],
        })

        const textBlock = response.content.find((b) => b.type === "text")
        if (!textBlock || textBlock.type !== "text") {
          throw new Error("EXTRACTION_NO_TEXT")
        }

        payload = parseExtractionJson(textBlock.text)
        modelId = response.model
        source = "claude"
      }

      await ctx.runMutation(internal.extractions.markSucceeded, {
        extractionId,
        payload,
        modelId,
        source,
      })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      await ctx.runMutation(internal.extractions.markFailed, {
        extractionId,
        errorMessage,
      })
    }
  },
})
