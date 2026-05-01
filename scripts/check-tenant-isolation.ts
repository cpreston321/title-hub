/**
 * Schema-isolation check (per TECHINAL-SPEC §3).
 *
 * Every table in convex/schema.ts must either:
 *   1. Be in GLOBAL_TABLES (platform-shared or per-user), or
 *   2. Have at least one index whose leading field is "tenantId".
 *
 * Run via `bun scripts/check-tenant-isolation.ts`. Exits non-zero on violation.
 */
import schema from "../convex/schema"

// Allowlisted tables without `tenantId`. Add new platform-shared globals
// (e.g. states, counties, countyRecordingRules, underwriters) here.
const GLOBAL_TABLES = new Set<string>([
  "tenants",
  "states",
  "counties",
  "underwriters",
  "underwriterEndorsementCodes",
  "transactionTypes",
  "countyRecordingRules",
  // Platform-level allowlist: who can create new organizations. Spans
  // tenants by design — see convex/auth.ts allowUserToCreateOrganization.
  "systemAdmins",
])

type IndexInfo = { indexDescriptor: string; fields: string[] }

function tableIndexes(def: unknown): IndexInfo[] {
  // The Convex SDK exposes this via a leading-space-prefixed method name; treat
  // as an unstable API and tolerate its absence.
  const fn = (def as Record<string, unknown>)[" indexes"]
  if (typeof fn !== "function") return []
  return (fn as () => IndexInfo[]).call(def) ?? []
}

const violations: string[] = []

for (const [tableName, def] of Object.entries(schema.tables)) {
  if (GLOBAL_TABLES.has(tableName)) continue
  const indexes = tableIndexes(def)
  const leadsWithTenant = indexes.some((idx) => idx.fields[0] === "tenantId")
  if (!leadsWithTenant) {
    violations.push(
      `  - "${tableName}" has no index leading with tenantId (indexes: ${
        indexes.map((i) => i.indexDescriptor).join(", ") || "none"
      })`,
    )
  }
}

if (violations.length > 0) {
  console.error("Tenant-isolation check FAILED:")
  console.error(violations.join("\n"))
  console.error(
    "\nFix: add `.index(\"by_tenant_*\", [\"tenantId\", ...])` to the table, " +
      "or add it to GLOBAL_TABLES in scripts/check-tenant-isolation.ts " +
      "if it is intentionally platform-shared.",
  )
  process.exit(1)
}

console.log(
  `Tenant-isolation check passed (${
    Object.keys(schema.tables).length
  } tables, ${GLOBAL_TABLES.size} allowlisted as global).`,
)
