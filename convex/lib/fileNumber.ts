// File-number pattern engine.
//
// Owners configure how their firm numbers files. Patterns are template
// strings with brace-delimited tokens that get replaced at generation
// time. Tokens carry no state — the pattern engine is pure. The counter
// (nextSeq) and cadence reset live on the policy row in the database.
//
// Why a small DSL and not a free-form callback / "format string": every
// surface that touches file numbers (admin preview, create form preview,
// the actual create mutation) needs to produce the same string from the
// same inputs. A token registry guarantees that. It also lets the UI
// show the catalogue of tokens with descriptions and click-to-insert.

export type Cadence = 'never' | 'yearly' | 'monthly'

export type FormatContext = {
  /** The sequence number that should appear in this file number. */
  seq: number
  /** Date used to resolve {YYYY}, {MM}, {DD}. UTC. */
  date: Date
  /** County code (e.g. "MARION"). Optional — `{COUNTY}` resolves to "" if missing. */
  countyCode?: string | null
  /** State code (e.g. "IN"). Optional. */
  stateCode?: string | null
  /** Transaction type code ("purchase", "refi", …). Optional. */
  transactionType?: string | null
}

export type Token = {
  /** The literal token name (without braces). `SEQ` matches `{SEQ:4}` too. */
  name: string
  /** Short label for the admin UI. */
  label: string
  /** Concrete example shown next to the chip ("2026", "MARION", "0042"). */
  example: string
  /** True when the token accepts a `:N` width parameter. */
  parameterized?: boolean
  /** Resolves the token to its string value. `param` is the optional `:N`. */
  resolve: (ctx: FormatContext, param: string | null) => string
}

const pad = (n: number, width: number) =>
  String(n).padStart(Math.max(1, Math.min(width, 8)), '0')

export const TOKENS: ReadonlyArray<Token> = [
  {
    name: 'YYYY',
    label: 'Year (4-digit)',
    example: '2026',
    resolve: (ctx) => String(ctx.date.getUTCFullYear()),
  },
  {
    name: 'YY',
    label: 'Year (2-digit)',
    example: '26',
    resolve: (ctx) => String(ctx.date.getUTCFullYear() % 100).padStart(2, '0'),
  },
  {
    name: 'MM',
    label: 'Month',
    example: '05',
    resolve: (ctx) => String(ctx.date.getUTCMonth() + 1).padStart(2, '0'),
  },
  {
    name: 'DD',
    label: 'Day of month',
    example: '04',
    resolve: (ctx) => String(ctx.date.getUTCDate()).padStart(2, '0'),
  },
  {
    name: 'COUNTY',
    label: 'County code',
    example: 'MARION',
    resolve: (ctx) => (ctx.countyCode ?? '').toUpperCase(),
  },
  {
    name: 'STATE',
    label: 'State code',
    example: 'IN',
    resolve: (ctx) => (ctx.stateCode ?? '').toUpperCase(),
  },
  {
    name: 'TXN',
    label: 'Transaction type (full)',
    example: 'PURCHASE',
    resolve: (ctx) => (ctx.transactionType ?? '').toUpperCase(),
  },
  {
    name: 'TXN3',
    label: 'Transaction type (3-letter)',
    example: 'PUR',
    resolve: (ctx) => (ctx.transactionType ?? '').slice(0, 3).toUpperCase(),
  },
  {
    name: 'SEQ',
    label: 'Sequence',
    example: '0042',
    parameterized: true,
    resolve: (ctx, param) => pad(ctx.seq, param ? parseInt(param, 10) : 4),
  },
] as const

const tokenByName = new Map(TOKENS.map((t) => [t.name, t]))

export const DEFAULT_PATTERN = '{YYYY}-{SEQ:4}'

// Token names start with an uppercase letter and may contain digits
// (TXN3, SEQ, COUNTY, …). The {SEQ:N} parameter is a 1–8-digit width.
const TOKEN_RE = /\{([A-Z][A-Z0-9]*)(?::([0-9]+))?\}/g
// Lenient variant used by validate(): catches lowercase tokens so we can
// flag them. Same shape but case-insensitive on the name.
const VALIDATE_TOKEN_RE = /\{([A-Za-z][A-Za-z0-9]*)(?::([^}]*))?\}/g

/**
 * Render a pattern with the given context. Unknown tokens render as the
 * empty string — validate() catches them ahead of time so this is only
 * defensive.
 */
export function formatFileNumber(pattern: string, ctx: FormatContext): string {
  return pattern.replace(TOKEN_RE, (_, name, param) => {
    const tok = tokenByName.get(name)
    if (!tok) return ''
    return tok.resolve(ctx, param ?? null)
  })
}

export type ValidationIssue = {
  kind:
    | 'EMPTY'
    | 'TOO_LONG'
    | 'MISSING_SEQ'
    | 'UNKNOWN_TOKEN'
    | 'BAD_PARAM'
    | 'INVALID_CHARS'
  message: string
}

const PATTERN_MAX_LENGTH = 64
// Allow only safe filename-y characters in literal portions of the pattern
// so file numbers stay portable across systems (URLs, exports, recorder
// software). Tokens themselves are stripped before this check.
const SAFE_LITERALS = /^[A-Za-z0-9 _\-./]*$/

export function validatePattern(pattern: string): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const trimmed = pattern.trim()
  if (trimmed.length === 0) {
    issues.push({ kind: 'EMPTY', message: 'Pattern cannot be empty.' })
    return issues
  }
  if (trimmed.length > PATTERN_MAX_LENGTH) {
    issues.push({
      kind: 'TOO_LONG',
      message: `Pattern is ${trimmed.length} characters; max is ${PATTERN_MAX_LENGTH}.`,
    })
  }

  let hasSeq = false
  const tokenRe = new RegExp(VALIDATE_TOKEN_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = tokenRe.exec(trimmed)) !== null) {
    const [, rawName, rawParam] = match
    const name = rawName.toUpperCase()
    if (rawName !== name) {
      issues.push({
        kind: 'UNKNOWN_TOKEN',
        message: `Token "${rawName}" must be uppercase.`,
      })
      continue
    }
    const tok = tokenByName.get(name)
    if (!tok) {
      issues.push({
        kind: 'UNKNOWN_TOKEN',
        message: `Unknown token "{${rawName}}".`,
      })
      continue
    }
    if (rawParam !== undefined) {
      if (!tok.parameterized) {
        issues.push({
          kind: 'BAD_PARAM',
          message: `Token "{${name}}" doesn't accept a width.`,
        })
      } else if (!/^[1-8]$/.test(rawParam)) {
        issues.push({
          kind: 'BAD_PARAM',
          message: `Width on "{${name}:${rawParam}}" must be 1–8.`,
        })
      }
    }
    if (name === 'SEQ') hasSeq = true
  }
  if (!hasSeq) {
    issues.push({
      kind: 'MISSING_SEQ',
      message: 'Pattern must include {SEQ} (or {SEQ:N}) so files don\'t collide.',
    })
  }

  // Strip tokens, then check the remaining literal portions are filename-safe.
  const literal = trimmed.replace(tokenRe, '')
  if (!SAFE_LITERALS.test(literal)) {
    issues.push({
      kind: 'INVALID_CHARS',
      message:
        'Use only letters, digits, dashes, underscores, dots, slashes, and spaces between tokens.',
    })
  }

  return issues
}

/**
 * Boundary string for a given date + cadence. Equality of two boundaries
 * means "same window — don't reset the counter".
 */
export function boundaryFor(date: Date, cadence: Cadence): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  if (cadence === 'never') return ''
  if (cadence === 'yearly') return String(y)
  return `${y}-${m}`
}
