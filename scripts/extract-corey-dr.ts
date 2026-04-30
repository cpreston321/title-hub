/**
 * Live extraction smoke test — runs the same Claude extraction the Convex
 * action does, but standalone against the PA + counter-offer PDFs in
 * data/. Useful for verifying live output matches the mock fixtures.
 *
 * Requirements:
 *   - ANTHROPIC_API_KEY set in your shell (NOT the Convex env, since this
 *     runs locally — `export ANTHROPIC_API_KEY=sk-ant-...`)
 *
 * Usage:
 *   bun scripts/extract-corey-dr.ts
 *   bun scripts/extract-corey-dr.ts --doc pa     # only the PA
 *   bun scripts/extract-corey-dr.ts --doc c1     # only the counter offer
 */

import Anthropic from "@anthropic-ai/sdk"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const SYSTEM_PROMPT = `You extract structured fields from US real-estate transaction documents: purchase agreements, counter offers, title commitments, title search reports, closing disclosures, deeds, and seller's disclosures.

Read the document and emit a single JSON object matching the schema below. Output ONLY the JSON object — no prose, no markdown fences, no commentary before or after.

Schema:
{
  "documentKind": "purchase_agreement" | "counter_offer" | "title_search" | "commitment" | "closing_disclosure" | "deed" | "sellers_disclosure" | "other",
  "parties": Array<{
    "role": "buyer" | "seller" | "lender" | "borrower" | "trustee" | "signer" | "broker" | "title_company" | "escrow_agent" | "other",
    "legalName": string,
    "capacity"?: string
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
    "purchasePrice"?: number,
    "earnestMoney"?: { "amount"?: number, "refundable"?: boolean, "depositDays"?: number },
    "sellerConcessions"?: number,
    "buyerBrokerCompensation"?: { "amount"?: number, "percent"?: number, "paidBy"?: "buyer" | "seller" }
  } | null,
  "dates": {
    "effectiveDate"?: string,
    "closingDate"?: string,
    "financingApprovalDays"?: number,
    "expirationOfOffer"?: string
  } | null,
  "titleCompany": {
    "name"?: string,
    "phone"?: string,
    "selectedBy"?: "buyer" | "seller" | "shared"
  } | null,
  "contingencies": string[],
  "amendments": string[],
  "notes": string[]
}

Conventions:
- Use null for whole sections not present. Use undefined keys for missing sub-fields, not empty strings.
- Numbers must be plain numbers — no "$", no commas.
- Dates must be ISO 8601 (YYYY-MM-DD).
- If a counter offer modifies a price, capture the NEW price in financial.purchasePrice and describe the change as one bullet in amendments.
- People with a signing capacity ("Rene S Kotter, AIF") → legalName: "Rene S Kotter", capacity: "AIF".
- Do not invent values. If you cannot read a field with confidence, omit it.`

const FIXTURES = {
  pa: { path: "data/PA - 3324 Corey Dr.pdf", docTypeHint: "purchase_agreement" },
  c1: { path: "data/C1 - 3324 Corey Dr.pdf", docTypeHint: "counter_offer" },
} as const

function parseExtractionJson(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed)
    } catch {
      /* fall through */
    }
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence && fence[1]) {
    try {
      return JSON.parse(fence[1].trim())
    } catch {
      /* fall through */
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
          return JSON.parse(trimmed.slice(start, i + 1))
        }
      }
    }
  }
  throw new Error("No JSON object found in model response")
}

async function extract(client: Anthropic, fixture: keyof typeof FIXTURES) {
  const { path, docTypeHint } = FIXTURES[fixture]
  const absPath = resolve(process.cwd(), path)
  const bytes = readFileSync(absPath)
  const base64 = bytes.toString("base64")

  console.log(`\n=== ${fixture.toUpperCase()} (${path}) ===`)
  console.log(`bytes: ${bytes.length}, hint: ${docTypeHint}`)

  const start = Date.now()
  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
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
          {
            type: "text",
            text: `The user has classified this document as: ${docTypeHint}. Verify and extract per schema. Return JSON only.`,
          },
        ],
      },
    ],
  })
  const elapsed = Date.now() - start

  const textBlock = response.content.find((b) => b.type === "text")
  if (!textBlock || textBlock.type !== "text") {
    console.error("No text block in response")
    return
  }

  console.log(`elapsed: ${elapsed}ms`)
  console.log(
    `usage: in=${response.usage.input_tokens} out=${response.usage.output_tokens} ` +
      `cache_read=${response.usage.cache_read_input_tokens ?? 0} ` +
      `cache_create=${response.usage.cache_creation_input_tokens ?? 0}`,
  )

  try {
    const parsed = parseExtractionJson(textBlock.text)
    console.log("\nExtracted JSON:\n")
    console.log(JSON.stringify(parsed, null, 2))
  } catch (err) {
    console.error("Failed to parse JSON:", err)
    console.log("\nRaw model output:\n")
    console.log(textBlock.text)
  }
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error(
      "ANTHROPIC_API_KEY is not set in your shell environment. " +
        "This script runs locally, not in Convex — set it in your terminal:\n" +
        "  export ANTHROPIC_API_KEY=sk-ant-...",
    )
    process.exit(1)
  }

  const client = new Anthropic({ apiKey })
  const args = process.argv.slice(2)
  const docFlag = args.indexOf("--doc")
  const target =
    docFlag >= 0 && args[docFlag + 1] ? (args[docFlag + 1] as keyof typeof FIXTURES) : "all"

  if (target === "all" || target === ("all" as typeof target)) {
    await extract(client, "pa")
    await extract(client, "c1")
  } else if (target in FIXTURES) {
    await extract(client, target)
  } else {
    console.error(`Unknown --doc value: ${target}. Valid: pa, c1, all.`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
