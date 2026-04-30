/**
 * Vesting normalizer (Sprint 5).
 *
 * Pure helpers for canonicalizing legal names, parsing joint vesting, and
 * classifying signing capacity. Used by the reconciliation engine to surface
 * vesting/authority findings.
 */

const SUFFIXES = new Set([
  "JR",
  "SR",
  "II",
  "III",
  "IV",
  "V",
  "ESQ",
  "MD",
  "PHD",
  "DDS",
])

const ENTITY_TOKENS = [
  "LLC",
  "L.L.C.",
  "INC",
  "INC.",
  "INCORPORATED",
  "CORP",
  "CORP.",
  "CORPORATION",
  "LP",
  "L.P.",
  "LLP",
  "L.L.P.",
  "PA",
  "P.A.",
  "PLLC",
  "P.L.L.C.",
  "CO",
  "COMPANY",
  "TRUST",
  "FOUNDATION",
] as const

const TRUST_TOKENS = ["TRUST", "REVOCABLE TRUST", "IRREVOCABLE TRUST", "LIVING TRUST"]
const ESTATE_TOKENS = ["ESTATE OF", "ESTATE", "DECEASED", "DEC'D"]

const CAPACITY_PATTERNS: ReadonlyArray<{
  re: RegExp
  capacity:
    | "AIF"
    | "POA"
    | "trustee"
    | "successor_trustee"
    | "executor"
    | "personal_representative"
    | "guardian"
    | "decedent"
}> = [
  { re: /,?\s*A\.?\s*I\.?\s*F\.?\s*$/i, capacity: "AIF" },
  { re: /,?\s*P\.?\s*O\.?\s*A\.?\s*$/i, capacity: "POA" },
  { re: /,?\s*ATTORNEY[- ]IN[- ]FACT\s*$/i, capacity: "AIF" },
  { re: /,?\s*POWER\s+OF\s+ATTORNEY\s*$/i, capacity: "POA" },
  { re: /,?\s*SUCCESSOR\s+TRUSTEE\s*$/i, capacity: "successor_trustee" },
  { re: /,?\s*TRUSTEE(\s+OF\s+.+)?\s*$/i, capacity: "trustee" },
  { re: /,?\s*EXECUTOR(IX|RIX)?\s*$/i, capacity: "executor" },
  {
    re: /,?\s*(PERSONAL\s+REPRESENTATIVE|PR)\s*$/i,
    capacity: "personal_representative",
  },
  { re: /,?\s*GUARDIAN\s*$/i, capacity: "guardian" },
  { re: /,?\s*DECEASED\s*$/i, capacity: "decedent" },
  { re: /,?\s*DEC'?D\s*$/i, capacity: "decedent" },
]

export type EntitySubtype =
  | "llc"
  | "corp"
  | "lp"
  | "llp"
  | "pa"
  | "pllc"
  | "trust"
  | "estate"
  | "company"
  | "foundation"
  | "unknown"

export type NormalizedName = {
  raw: string
  canonical: string // upper-case, suffix-normalized, trimmed
  surname?: string
  given?: string
  suffix?: string
  capacity?:
    | "AIF"
    | "POA"
    | "trustee"
    | "successor_trustee"
    | "executor"
    | "personal_representative"
    | "guardian"
    | "decedent"
  entitySubtype?: EntitySubtype
  isPerson: boolean
  isEntity: boolean
  isTrust: boolean
  isEstate: boolean
}

function uppercase(s: string): string {
  return s.replace(/\s+/g, " ").trim().toUpperCase()
}

function detectEntitySubtype(canonical: string): EntitySubtype | undefined {
  const tokens = canonical.replace(/\./g, "").split(/\s+/)
  const last = tokens[tokens.length - 1]
  if (!last) return undefined
  if (last === "LLC" || last === "LLC,") return "llc"
  if (last === "INC" || last === "CORP" || last === "CORPORATION") return "corp"
  if (last === "LP") return "lp"
  if (last === "LLP") return "llp"
  if (last === "PA") return "pa"
  if (last === "PLLC") return "pllc"
  if (canonical.includes("TRUST")) return "trust"
  if (canonical.includes("ESTATE")) return "estate"
  if (canonical.includes("FOUNDATION")) return "foundation"
  if (last === "CO" || last === "COMPANY") return "company"
  return undefined
}

function looksLikeEntity(canonical: string): boolean {
  const tokens = canonical.replace(/\./g, "").split(/\s+/)
  return tokens.some((t) =>
    ENTITY_TOKENS.includes(t as (typeof ENTITY_TOKENS)[number]),
  )
}

function looksLikeTrust(canonical: string): boolean {
  return TRUST_TOKENS.some((t) => canonical.includes(t))
}

function looksLikeEstate(canonical: string): boolean {
  return ESTATE_TOKENS.some((t) => canonical.includes(t))
}

export function normalizeLegalName(input: string): NormalizedName {
  const raw = input
  let working = uppercase(input).replace(/\s+,/g, ",")

  // Capacity suffix detection — strip from canonical name.
  let capacity: NormalizedName["capacity"]
  for (const pattern of CAPACITY_PATTERNS) {
    if (pattern.re.test(working)) {
      capacity = pattern.capacity
      working = working.replace(pattern.re, "").replace(/,\s*$/, "").trim()
      break
    }
  }

  const isTrust = looksLikeTrust(working)
  const isEstate = looksLikeEstate(working)
  const isEntity = looksLikeEntity(working) || isTrust || isEstate
  const entitySubtype = isEntity ? detectEntitySubtype(working) : undefined

  let surname: string | undefined
  let given: string | undefined
  let suffix: string | undefined

  if (!isEntity) {
    // Person: try "Last, First Middle Suffix" first, then "First Middle Last Suffix".
    const commaSplit = working.split(",")
    if (commaSplit.length === 2) {
      surname = commaSplit[0].trim()
      const tail = commaSplit[1].trim().split(/\s+/)
      if (tail.length > 0) {
        const last = tail[tail.length - 1]
        if (SUFFIXES.has(last.replace(/\./g, ""))) {
          suffix = last.replace(/\./g, "")
          given = tail.slice(0, -1).join(" ").trim() || undefined
        } else {
          given = tail.join(" ")
        }
      }
    } else {
      const tokens = working.split(/\s+/)
      const last = tokens[tokens.length - 1]
      if (last && SUFFIXES.has(last.replace(/\./g, ""))) {
        suffix = last.replace(/\./g, "")
        const rest = tokens.slice(0, -1)
        if (rest.length >= 2) {
          surname = rest[rest.length - 1]
          given = rest.slice(0, -1).join(" ")
        }
      } else if (tokens.length >= 2) {
        surname = tokens[tokens.length - 1]
        given = tokens.slice(0, -1).join(" ")
      } else if (tokens.length === 1) {
        surname = tokens[0]
      }
    }
  }

  return {
    raw,
    canonical: working,
    surname,
    given,
    suffix,
    capacity,
    entitySubtype,
    isPerson: !isEntity,
    isEntity,
    isTrust,
    isEstate,
  }
}

/**
 * Parse a legal-name string that may contain joint vesting (multiple parties).
 * Returns the parsed parties and the joint vesting form if explicit.
 *
 * Examples:
 *   "John Smith and Jane Smith"               → 2 parties, vestingForm: undefined
 *   "John Smith and Jane Smith, JTROS"        → 2 parties, vestingForm: "JTROS"
 *   "John Smith and Jane Smith as TBE"        → 2 parties, vestingForm: "TBE"
 *   "Acme LLC"                                 → 1 party, vestingForm: undefined
 */
export type VestingForm =
  | "JTROS" // joint tenants with right of survivorship
  | "TIC" // tenants in common
  | "TBE" // tenants by the entirety
  | "CP" // community property

export type ParsedVesting = {
  parties: NormalizedName[]
  vestingForm?: VestingForm
}

const VESTING_FORM_PATTERNS: ReadonlyArray<{ re: RegExp; form: VestingForm }> = [
  { re: /\bJTROS\b/i, form: "JTROS" },
  { re: /\bJ\.?\s*T\.?\s*W\.?\s*R\.?\s*O\.?\s*S\.?\b/i, form: "JTROS" },
  { re: /\bJOINT\s+TENANT(?:S)?(?:\s+WITH\s+RIGHT\s+OF\s+SURVIVORSHIP)?\b/i, form: "JTROS" },
  { re: /\bTENANT(?:S)?\s+IN\s+COMMON\b/i, form: "TIC" },
  { re: /\bTIC\b/i, form: "TIC" },
  { re: /\bTENANT(?:S)?\s+BY\s+THE\s+ENTIRET(?:Y|IES)\b/i, form: "TBE" },
  { re: /\bTBE\b/i, form: "TBE" },
  { re: /\bCOMMUNITY\s+PROPERTY\b/i, form: "CP" },
]

export function parseVesting(input: string): ParsedVesting {
  let working = input.trim()
  let vestingForm: VestingForm | undefined

  for (const pat of VESTING_FORM_PATTERNS) {
    if (pat.re.test(working)) {
      vestingForm = pat.form
      working = working.replace(pat.re, "")
      break
    }
  }

  // Strip trailing connectives like ", as " left over from form removal.
  working = working
    .replace(/,?\s*AS\s*$/i, "")
    .replace(/,\s*$/, "")
    .trim()

  // Split on " and " or " & " (case-insensitive). Don't split on commas because
  // a name like "Smith, John" uses a comma internally.
  const parts = working
    .split(/\s+(?:AND|&)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    parties: parts.map(normalizeLegalName),
    vestingForm,
  }
}

/**
 * Compare two normalized names for "same person". Tolerates suffix differences
 * and missing-given-name cases. Returns:
 *   - "exact": canonical strings match
 *   - "near": surname matches AND (given matches OR one is missing)
 *   - "different": no match
 */
export function compareNames(
  a: NormalizedName,
  b: NormalizedName,
): "exact" | "near" | "different" {
  if (a.canonical === b.canonical) return "exact"
  if (a.isEntity || b.isEntity) {
    // Entities: canonical equality only — too risky to fuzzy-match LLCs.
    return "different"
  }
  if (!a.surname || !b.surname) return "different"
  if (a.surname !== b.surname) return "different"
  if (!a.given || !b.given) return "near"
  if (a.given === b.given) return "exact"
  // Initial vs full given name (e.g. "J" vs "JOHN")
  const ag = a.given.split(/\s+/)[0]
  const bg = b.given.split(/\s+/)[0]
  if (ag.length === 1 && bg.startsWith(ag)) return "near"
  if (bg.length === 1 && ag.startsWith(bg)) return "near"
  return "different"
}
