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
import { Buffer } from 'node:buffer'

// HMAC-SHA256(secret, message) -> lowercase hex. Web Crypto, no node:crypto
// dependency, so the helper matches the server-side scheme verbatim.
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message)
  )
  return Array.from(new Uint8Array(sig), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
}

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
        passwordSet: boolean
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
      const pwMark = r.passwordSet ? c.green('· password set') : ''
      console.log(
        c.green('✓') +
          ` ${c.bold(r.email)} ${userMark} → ${c.plum(r.tenantSlug)} ${c.dim(
            `(${r.tenantName})`
          )} as ${c.bold(r.role)} ${memberMark} ${pwMark}`
      )
    },
  },
  {
    name: 'set-password',
    args: '<email> <password>',
    description:
      "Reset a user's password directly. Updates (or creates) their credential account in Better Auth.",
    run: (args) => {
      const email = requireArg(args, 0, 'email')
      const password = requireArg(args, 1, 'password')
      const r = runConvex<{
        email: string
        userId: string
        accountCreated: boolean
      }>('systemAdmins:setUserPassword', { email, password })
      const mark = r.accountCreated
        ? c.green('+ credential account created')
        : c.green('· password updated')
      console.log(c.green('✓') + ` ${c.bold(r.email)} ${mark}`)
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
    name: 'simulate-email',
    args: '[tenant-slug] [--file=<file-number>] [--from=<email>] [--subject=<text>] [--body=<text>] [--attach=<path>]... [--suspicious=1] [--spf=pass|fail] [--dkim=pass|fail] [--dmarc=pass|fail] [--reply-to=<email>] [--site-url=<url>]',
    description:
      'Send a Postmark-shaped inbound email to /integrations/email/inbound (HMAC-signed). Auto-creates an email_inbound integration if missing. Defaults to the first tenant.',
    run: async (args) => {
      const positionals: Array<string> = []
      const flags: Record<string, string> = {}
      const attachments: Array<string> = []
      for (const arg of args) {
        if (arg.startsWith('--attach=')) {
          attachments.push(arg.slice('--attach='.length))
        } else if (arg.startsWith('--')) {
          const eq = arg.indexOf('=')
          if (eq < 0) {
            console.error(c.red(`Flag without value: ${arg}`))
            process.exit(2)
          }
          flags[arg.slice(2, eq)] = arg.slice(eq + 1)
        } else {
          positionals.push(arg)
        }
      }

      const tenantSlug = positionals[0] ?? (await pickFirstTenantSlug())
      if (!tenantSlug) {
        console.error(
          c.red('No tenants on this deployment. Sign up and create one first.')
        )
        process.exit(1)
      }

      const integration = runConvex<{
        integrationId: string
        inboundSecret: string
        alreadyExisted: boolean
        tenantSlug: string
        name: string
        status: string
      }>('systemAdmins:adminGetOrCreateEmailIntegration', { tenantSlug })

      console.log(
        c.bold('Email integration: ') +
          (integration.alreadyExisted ? c.dim('· reused') : c.green('+ created')) +
          ' ' +
          c.dim(integration.integrationId)
      )

      const siteUrl =
        flags['site-url'] ??
        process.env.VITE_CONVEX_SITE_URL ??
        process.env.CONVEX_SITE_URL
      if (!siteUrl) {
        console.error(
          c.red(
            'Site URL not found. Set VITE_CONVEX_SITE_URL in .env.local or pass --site-url=<url>'
          )
        )
        process.exit(1)
      }

      const fromAddress = flags.from ?? 'agent@example.com'
      const fileNumber = flags.file
      const subject =
        flags.subject ??
        (fileNumber
          ? `Re: file ${fileNumber} — signed docs attached`
          : 'No file number — please route')
      const body =
        flags.body ??
        (fileNumber
          ? `Hi,\n\nAttaching the latest for file ${fileNumber}.\n\nThanks`
          : 'Attaching docs — please route to the right file.')

      const decodedAttachments: Array<{
        Name: string
        ContentType: string
        Content: string
        ContentLength: number
      }> = []
      for (const path of attachments) {
        if (!existsSync(path)) {
          console.error(c.red(`Attachment not found: ${path}`))
          process.exit(1)
        }
        const buf = await readFile(path)
        const ext = extname(path).toLowerCase()
        const mime =
          ext === '.pdf'
            ? 'application/pdf'
            : ext === '.txt'
              ? 'text/plain'
              : ext === '.docx'
                ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                : 'application/octet-stream'
        decodedAttachments.push({
          Name: path.split('/').pop() ?? 'attachment',
          ContentType: mime,
          Content: buf.toString('base64'),
          ContentLength: buf.length,
        })
      }

      // If no real attachment was provided, ship a tiny fake PDF so the
      // ingest path exercises end-to-end (storage write + extraction
      // schedule). Skip it if the user asked for a no-attachment test
      // explicitly via --no-attachment.
      if (decodedAttachments.length === 0 && flags['no-attachment'] !== '1') {
        const fake = Buffer.from(
          '%PDF-1.4\n% simulate-email synthetic attachment\n',
          'utf-8'
        )
        decodedAttachments.push({
          Name: 'simulated.pdf',
          ContentType: 'application/pdf',
          Content: fake.toString('base64'),
          ContentLength: fake.length,
        })
      }

      const payload: Record<string, unknown> = {
        MessageID: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        From: fromAddress,
        FromName: flags['from-name'] ?? '',
        To:
          flags.to ?? `inbox+${integration.tenantSlug}@title.example.com`,
        Subject: subject,
        TextBody: body,
        Date: new Date().toISOString(),
        Attachments: decodedAttachments,
      }
      // Authenticity-test convenience flags. --suspicious sets DMARC=fail
      // so the spam scorer rates the message as high_risk. Pass any of
      // --spf / --dkim / --dmarc to override individual verdicts.
      if (flags.suspicious === '1') {
        payload.SpfResult = flags.spf ?? 'fail'
        payload.DkimResult = flags.dkim ?? 'fail'
        payload.DmarcResult = flags.dmarc ?? 'fail'
        if (!flags['reply-to']) payload.ReplyTo = 'phisher@elsewhere.example'
      } else {
        payload.SpfResult = flags.spf ?? 'pass'
        payload.DkimResult = flags.dkim ?? 'pass'
        payload.DmarcResult = flags.dmarc ?? 'pass'
      }
      if (flags['reply-to']) payload.ReplyTo = flags['reply-to']
      const rawBody = JSON.stringify(payload)
      const ts = String(Date.now())
      const sig = await hmacHex(integration.inboundSecret, `${ts}.${rawBody}`)

      const url = `${siteUrl.replace(/\/+$/, '')}/integrations/email/inbound?id=${integration.integrationId}`

      console.log(c.bold('POST ') + c.dim(url))
      console.log(
        c.dim(
          `  subject: ${subject}\n  from: ${fromAddress}\n  attachments: ${decodedAttachments.length}`
        )
      )

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Title-Timestamp': ts,
          'X-Title-Signature': `sha256=${sig}`,
        },
        body: rawBody,
      })
      const text = await res.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }

      if (!res.ok) {
        console.log(c.red(`✗ ${res.status} ${res.statusText}`))
        console.log(c.dim(typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)))
        process.exit(1)
      }

      const r = parsed as {
        inboundEmailId?: string
        autoAttached?: boolean
        deduped?: boolean
        confidence?: number
        matchedFileId?: string | null
      }
      console.log(
        c.green('✓') +
          ` ${res.status} ${res.statusText} ${c.dim('·')} ${r.inboundEmailId ?? ''}`
      )
      const verdict = r.deduped
        ? c.dim('deduped (already ingested)')
        : r.autoAttached
          ? c.green(
              `auto-attached → ${r.matchedFileId ?? '?'}` +
                (typeof r.confidence === 'number'
                  ? ` (${Math.round(r.confidence * 100)}%)`
                  : '')
            )
          : c.amber('quarantined') +
            (typeof r.confidence === 'number'
              ? c.dim(` (best ${Math.round(r.confidence * 100)}%)`)
              : '')
      console.log(`  ${verdict}`)
      console.log(
        c.dim(
          '  Open http://localhost:3000/mail to see the row in the inbox.'
        )
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
  console.log(c.dim('  bun run admin set-password alice@firm.com hunter2'))
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
