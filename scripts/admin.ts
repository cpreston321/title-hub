#!/usr/bin/env bun
/**
 * Title Hub admin CLI ───────────────────── Small utilities for managing the
 * deployment outside the app. Each command shells out to `npx convex run`
 * against the connected deployment, so it inherits whatever auth `convex dev` /
 * CONVEX_DEPLOY_KEY is currently set to.
 *
 * Bun run admin help bun run admin list-admins bun run admin add-admin
 * alice@firm.com bun run admin remove-admin alice@firm.com bun run admin
 * list-tenants
 *
 * Add a new command by writing an internal function in `convex/systemAdmins.ts`
 * (or another module) and registering an entry in `COMMANDS` below.
 */
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname } from 'node:path'

type CommandHandler = (args: Array<string>) => Promise<void> | void

type Command = {
  name: string
  args: string
  description: string
  run: CommandHandler
}

// ─────────────────────────────────────────────────────────────────────────
// Convex bridge
// ─────────────────────────────────────────────────────────────────────────

function runConvex<T = unknown>(
  fn: string,
  payload: Record<string, unknown> = {}
): T {
  const cli = ['convex', 'run', fn, JSON.stringify(payload)]
  const r = spawnSync('bunx', cli, {
    stdio: ['inherit', 'pipe', 'pipe'],
    encoding: 'utf-8',
    env: process.env,
  })
  if (r.status !== 0) {
    const err = (r.stderr || '').trim()
    if (err) console.error(err)
    process.exit(r.status ?? 1)
  }
  // `convex run` prints the JSON-encoded return value on stdout. If a
  // function returns undefined the output is empty.
  const out = (r.stdout || '').trim()
  if (!out) return undefined as T
  try {
    return JSON.parse(out) as T
  } catch {
    return out as unknown as T
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Output helpers
// ─────────────────────────────────────────────────────────────────────────

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  plum: (s: string) => `\x1b[35m${s}\x1b[0m`,
}

function fmtDate(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

function table(
  rows: ReadonlyArray<Record<string, string>>,
  columns: Array<string>
) {
  if (rows.length === 0) {
    console.log(c.dim('(no rows)'))
    return
  }
  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((r) => (r[col] ?? '').length))
  )
  const sep = widths.map((w) => '─'.repeat(w)).join('─┼─')
  console.log(
    c.bold(columns.map((col, i) => col.padEnd(widths[i])).join(' │ '))
  )
  console.log(c.dim(sep))
  for (const r of rows) {
    console.log(
      columns.map((col, i) => (r[col] ?? '').padEnd(widths[i])).join(' │ ')
    )
  }
}

function requireArg(args: Array<string>, i: number, label: string): string {
  const v = args[i]
  if (!v) {
    console.error(c.red(`Missing ${label}.`))
    process.exit(2)
  }
  return v
}

// ─────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────

type AdminRow = {
  betterAuthUserId: string
  email: string | null
  name: string | null
  addedAt: number
  addedBy: string | null
}

type TenantRow = {
  tenantId: string
  slug: string
  legalName: string
  status: string
  plan: string
  createdAt: number
}

const COMMANDS: ReadonlyArray<Command> = [
  {
    name: 'list-admins',
    args: '',
    description: 'Show every system admin (only role that can create orgs).',
    run: () => {
      const rows = runConvex<ReadonlyArray<AdminRow>>('systemAdmins:list')
      console.log(
        c.bold(
          `${rows.length} system admin${rows.length === 1 ? '' : 's'} on file`
        )
      )
      console.log()
      table(
        rows.map((r) => ({
          email: r.email ?? c.dim('(unknown email)'),
          name: r.name ?? '—',
          added: fmtDate(r.addedAt),
          via: r.addedBy ?? '—',
        })),
        ['email', 'name', 'added', 'via']
      )
    },
  },
  {
    name: 'add-admin',
    args: '<email>',
    description: 'Promote an existing user to system admin.',
    run: (args) => {
      const email = requireArg(args, 0, 'email')
      const r = runConvex<{ alreadyAdmin: boolean; email: string }>(
        'systemAdmins:addByEmail',
        { email }
      )
      if (r.alreadyAdmin) {
        console.log(c.amber('•') + ` ${r.email} is already a system admin.`)
      } else {
        console.log(
          c.green('✓') + ` ${c.bold(r.email)} promoted to system admin.`
        )
      }
    },
  },
  {
    name: 'remove-admin',
    args: '<email>',
    description:
      'Revoke system-admin from a user. Refuses to remove the last admin.',
    run: (args) => {
      const email = requireArg(args, 0, 'email')
      const r = runConvex<{ removed: boolean; email: string }>(
        'systemAdmins:removeByEmail',
        { email }
      )
      if (r.removed) {
        console.log(c.green('✓') + ` Removed ${c.bold(r.email)}.`)
      } else {
        console.log(
          c.dim('•') + ` ${r.email} was not a system admin. No change.`
        )
      }
    },
  },
  {
    name: 'list-tenants',
    args: '',
    description: 'Show every organization (tenant) on the deployment.',
    run: () => {
      const rows = runConvex<ReadonlyArray<TenantRow>>(
        'systemAdmins:listTenants'
      )
      console.log(
        c.bold(`${rows.length} tenant${rows.length === 1 ? '' : 's'} on file`)
      )
      console.log()
      table(
        rows.map((r) => ({
          slug: r.slug,
          name: r.legalName,
          status: r.status,
          plan: r.plan,
          created: fmtDate(r.createdAt),
        })),
        ['slug', 'name', 'status', 'plan', 'created']
      )
    },
  },
  {
    name: 'upload-test-data',
    args: '[tenant-slug]',
    description:
      'Upload the sample PDFs from /data into the tenant (creates files if missing). Defaults to the first tenant.',
    run: async (args) => {
      const tenantSlug = args[0] ?? (await pickFirstTenantSlug())
      if (!tenantSlug) {
        console.error(
          c.red('No tenants on this deployment. Sign up and create one first.')
        )
        process.exit(1)
      }
      console.log(
        c.bold(`Uploading test data into ${c.plum(tenantSlug)}`) + c.dim(' ...')
      )
      console.log()
      for (const fixture of TEST_FIXTURES) {
        await uploadFixture(tenantSlug, fixture)
      }
      console.log()
      console.log(
        c.green('✓') +
          ' Done. Open ' +
          c.bold('http://localhost:3000/files') +
          ' to see the uploaded documents.'
      )
    },
  },
  {
    name: 'dedupe-docs',
    args: '[tenant-slug]',
    description:
      'Remove duplicate documents within each file (keeps the most recent of every fileId × docType × title group).',
    run: async (args) => {
      const tenantSlug = args[0] ?? (await pickFirstTenantSlug())
      if (!tenantSlug) {
        console.error(c.red('No tenants on this deployment.'))
        process.exit(1)
      }
      const r = runConvex<{ removed: number; storageRemoved: number }>(
        'systemAdmins:adminDedupeDocuments',
        { tenantSlug }
      )
      if (r.removed === 0) {
        console.log(c.green('✓') + ` No duplicates in ${c.bold(tenantSlug)}.`)
      } else {
        console.log(
          c.green('✓') +
            ` Removed ${c.bold(String(r.removed))} duplicate document${
              r.removed === 1 ? '' : 's'
            } from ${c.bold(tenantSlug)}` +
            c.dim(
              ` (${r.storageRemoved} storage blob${r.storageRemoved === 1 ? '' : 's'} freed)`
            ) +
            '.'
        )
      }
    },
  },
  {
    name: 'seed-user',
    args: '<email> <password> <name> [tenant-slug] [--role=member|admin|owner]',
    description:
      'Create a user (or reuse one with this email) and add them to a tenant. Defaults to the first tenant and the `member` role.',
    run: async (args) => {
      const positionals: Array<string> = []
      let role: 'member' | 'admin' | 'owner' | undefined
      for (const arg of args) {
        if (arg.startsWith('--role=')) {
          const v = arg.slice('--role='.length)
          if (v !== 'member' && v !== 'admin' && v !== 'owner') {
            console.error(
              c.red(`--role must be member|admin|owner (got "${v}")`)
            )
            process.exit(2)
          }
          role = v
        } else {
          positionals.push(arg)
        }
      }
      const email = requireArg(positionals, 0, 'email')
      const password = requireArg(positionals, 1, 'password')
      const name = requireArg(positionals, 2, 'name')
      const tenantSlug = positionals[3] ?? (await pickFirstTenantSlug())
      if (!tenantSlug) {
        console.error(
          c.red('No tenants on this deployment. Sign up and create one first.')
        )
        process.exit(1)
      }

      const r = runConvex<{
        userId: string
        email: string
        tenantSlug: string
        tenantName: string
        role: string
        userCreated: boolean
        memberCreated: boolean
      }>('systemAdmins:seedUserAndAssign', {
        email,
        password,
        name,
        tenantSlug,
        ...(role ? { role } : {}),
      })

      const userMark = r.userCreated
        ? c.green('+ created')
        : c.dim('· existing')
      const memberMark = r.memberCreated
        ? c.green('+ added')
        : c.dim('· already member')
      console.log(
        c.green('✓') +
          ` ${c.bold(r.email)} ${userMark} → ${c.plum(r.tenantSlug)} ${c.dim(
            `(${r.tenantName})`
          )} as ${c.bold(r.role)} ${memberMark}`
      )
    },
  },
  {
    name: 'seed-recording-rules',
    args: '',
    description:
      'Seed county recording rules for the pilot counties (Marion, Hamilton). Idempotent — existing (county, docType) pairs are skipped.',
    run: () => {
      const r = runConvex<{
        totalInserted: number
        totalSkipped: number
        results: Array<{
          county: string
          fips: string
          inserted: number
          skipped: number
        }>
      }>('systemAdmins:adminSeedRecordingRules')

      table(
        r.results.map((row) => ({
          county: row.county,
          fips: row.fips,
          inserted: String(row.inserted),
          skipped: String(row.skipped),
        })),
        ['county', 'fips', 'inserted', 'skipped']
      )
      console.log()
      console.log(
        c.green('✓') +
          ` ${c.bold(String(r.totalInserted))} rule${
            r.totalInserted === 1 ? '' : 's'
          } inserted, ${c.dim(`${r.totalSkipped} already present`)}.`
      )
    },
  },
  {
    name: 'help',
    args: '',
    description: 'Show this help.',
    run: () => printHelp(),
  },
]

// ─────────────────────────────────────────────────────────────────────
// Test-data fixtures
// ─────────────────────────────────────────────────────────────────────

type PartyType = 'person' | 'entity' | 'trust' | 'estate'

type Fixture = {
  fileNumber: string
  countyName: string
  stateCode: string
  transactionType: string
  propertyAddress: {
    line1: string
    city: string
    state: string
    zip: string
  }
  parties: ReadonlyArray<{
    partyType: PartyType
    legalName: string
    role: string
    capacity?: string
  }>
  documents: ReadonlyArray<{
    path: string
    docType: string
    title: string
  }>
}

// Mapped from /data/*.pdf — see README of /data for source.
// Party names match the canonical fixture in convex/reconciliation.test.ts so
// extraction + reconciliation produce the same findings against this data.
const TEST_FIXTURES: ReadonlyArray<Fixture> = [
  {
    fileNumber: 'DEMO-CD-3324',
    countyName: 'Marion',
    stateCode: 'IN',
    transactionType: 'purchase',
    propertyAddress: {
      line1: '3324 Corey Dr',
      city: 'Indianapolis',
      state: 'IN',
      zip: '46227',
    },
    parties: [
      { partyType: 'person', legalName: 'Michelle Hicks', role: 'buyer' },
      {
        partyType: 'person',
        legalName: 'Rene S Kotter',
        role: 'seller',
        capacity: 'AIF',
      },
    ],
    documents: [
      {
        path: 'data/PA - 3324 Corey Dr.pdf',
        docType: 'purchase_agreement',
        title: 'Purchase Agreement — 3324 Corey Dr',
      },
      {
        path: 'data/C1 - 3324 Corey Dr.pdf',
        docType: 'counter_offer',
        title: 'Counter Offer #1 — 3324 Corey Dr',
      },
    ],
  },
  {
    fileNumber: 'DEMO-WS-5215',
    countyName: 'Marion',
    stateCode: 'IN',
    transactionType: 'purchase',
    propertyAddress: {
      line1: '5215 E Washington St',
      city: 'Indianapolis',
      state: 'IN',
      zip: '46219',
    },
    parties: [
      { partyType: 'person', legalName: 'James Whitlock', role: 'buyer' },
      { partyType: 'person', legalName: 'Patricia Whitlock', role: 'buyer' },
      {
        partyType: 'entity',
        legalName: 'Eastside Holdings LLC',
        role: 'seller',
      },
    ],
    documents: [
      {
        path: 'data/DataTrace - Sample of TPS Full Title - 5215 E WASHINGTON ST Indianapolis, IN 06232025.pdf',
        docType: 'title_search',
        title: 'DataTrace TPS Full Title — 5215 E Washington St',
      },
    ],
  },
]

async function pickFirstTenantSlug(): Promise<string | null> {
  const tenants = runConvex<ReadonlyArray<TenantRow>>(
    'systemAdmins:listTenants'
  )
  return tenants[0]?.slug ?? null
}

async function uploadFixture(tenantSlug: string, fixture: Fixture) {
  console.log(
    c.bold(`▸ ${fixture.fileNumber}`) +
      c.dim(
        ` — ${fixture.propertyAddress.line1}, ${fixture.propertyAddress.city}`
      )
  )

  const ensure = runConvex<{
    fileId: string
    created: boolean
  }>('systemAdmins:adminEnsureFile', {
    tenantSlug,
    fileNumber: fixture.fileNumber,
    countyName: fixture.countyName,
    stateCode: fixture.stateCode,
    transactionType: fixture.transactionType,
    propertyAddress: fixture.propertyAddress,
  })
  console.log(
    `  ${ensure.created ? c.green('+') : c.dim('·')} file ${
      ensure.created ? 'created' : 'exists'
    }`
  )

  for (const party of fixture.parties) {
    const r = runConvex<{ created: boolean }>('systemAdmins:adminAddParty', {
      tenantSlug,
      fileNumber: fixture.fileNumber,
      partyType: party.partyType,
      legalName: party.legalName,
      role: party.role,
      ...(party.capacity ? { capacity: party.capacity } : {}),
    })
    console.log(
      `  ${r.created ? c.green('+') : c.dim('·')} ${c.bold(party.role)} ${c.dim(
        `(${party.partyType})`
      )} — ${party.legalName}${party.capacity ? c.dim(` · ${party.capacity}`) : ''}`
    )
  }

  for (const doc of fixture.documents) {
    const path = doc.path
    if (!existsSync(path)) {
      console.log(`  ${c.amber('!')} skip ${doc.docType} — missing ${path}`)
      continue
    }

    const already = runConvex<boolean>('systemAdmins:adminFileHasDocument', {
      tenantSlug,
      fileNumber: fixture.fileNumber,
      docType: doc.docType,
      title: doc.title,
    })
    if (already) {
      console.log(
        `  ${c.dim('·')} ${c.bold(doc.docType)} ${c.dim('(already uploaded)')} → ${doc.title}`
      )
      continue
    }

    const uploadUrl = runConvex<string>('systemAdmins:adminGenerateUploadUrl')
    const buf = await readFile(path)
    const ext = extname(path).toLowerCase()
    const mime =
      ext === '.pdf'
        ? 'application/pdf'
        : ext === '.docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'application/octet-stream'
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': mime },
      body: buf,
    })
    if (!res.ok) {
      console.log(
        `  ${c.red('✗')} upload failed (${res.status}) for ${doc.docType}`
      )
      continue
    }
    const { storageId } = (await res.json()) as { storageId: string }

    const recorded = runConvex<{ sizeBytes?: number }>(
      'systemAdmins:adminRecordDocument',
      {
        tenantSlug,
        fileNumber: fixture.fileNumber,
        storageId,
        docType: doc.docType,
        title: doc.title,
      }
    )
    const kb =
      typeof recorded.sizeBytes === 'number'
        ? `${(recorded.sizeBytes / 1024).toFixed(1)} KB`
        : '?'
    console.log(
      `  ${c.green('+')} ${c.bold(doc.docType)} ${c.dim(
        `(${kb})`
      )} → ${doc.title}`
    )
  }
}

function printHelp() {
  console.log(c.bold('Title Hub admin'))
  console.log(c.dim('Manage the deployment from the terminal.'))
  console.log()
  console.log('Usage:')
  console.log(`  ${c.plum('bun run admin')} ${c.bold('<command>')} [args]`)
  console.log()
  console.log('Commands:')
  const w = Math.max(...COMMANDS.map((c) => `${c.name} ${c.args}`.length))
  for (const cmd of COMMANDS) {
    const left = `${cmd.name} ${cmd.args}`.padEnd(w)
    console.log(`  ${c.bold(left)}   ${c.dim(cmd.description)}`)
  }
  console.log()
  console.log('Examples:')
  console.log(c.dim('  bun run admin list-admins'))
  console.log(c.dim('  bun run admin add-admin alice@firm.com'))
  console.log(c.dim('  bun run admin remove-admin alice@firm.com'))
  console.log(c.dim('  bun run admin list-tenants'))
  console.log(
    c.dim("  bun run admin seed-user alice@firm.com hunter2 'Alice Doe'")
  )
  console.log(
    c.dim(
      "  bun run admin seed-user alice@firm.com hunter2 'Alice Doe' acme-title --role=admin"
    )
  )
  console.log(c.dim('  bun run admin seed-recording-rules'))
  console.log()
  console.log(
    c.dim(
      'Auth uses your local `npx convex` deployment. Pre-flight: `npx convex dev` running, or CONVEX_DEPLOY_KEY set.'
    )
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Entrypoint
// ─────────────────────────────────────────────────────────────────────────

const [, , name, ...rest] = process.argv

if (!name) {
  printHelp()
  process.exit(0)
}

const cmd = COMMANDS.find((c) => c.name === name)
if (!cmd) {
  console.error(c.red(`Unknown command: ${name}`))
  console.error()
  printHelp()
  process.exit(1)
}

try {
  await cmd.run(rest)
} catch (err) {
  console.error(c.red(err instanceof Error ? err.message : String(err)))
  process.exit(1)
}
