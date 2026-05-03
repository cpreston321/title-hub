import { ConvexError, v } from 'convex/values'
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { internal } from './_generated/api'
import {
  buildDocumentSearchText,
  deleteDocumentCascade,
  scheduleExtractionFor,
} from './files'
import { recordAudit } from './lib/audit'
import { fanOutNotification } from './notifications'
import { scoreEmail } from './lib/spamScore'
import { requireRole, requireTenant } from './lib/tenant'
import type { SpamReport } from './lib/spamScore'
import type { MutationCtx, QueryCtx } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'

// Per-message attachment ceiling. A typical email carries 1–5 PDFs; closing
// packages with hundreds of pages arrive as a single bundle, not as N
// attachments. If we ever cross this we surface the row as `failed` so a
// processor sees that something unusual showed up.
const MAX_ATTACHMENTS_PER_EMAIL = 50

// Confidence at which we auto-attach without a human in the loop. File-number
// matches sit at 0.9–0.95; address-only matches are capped below this so
// they always go to the triage queue.
const AUTO_ATTACH_CONFIDENCE = 0.85

// Spam tier above which we refuse to auto-attach even with a high-confidence
// classifier match. A spoofed email with the right file number in the
// subject is the worst-case wire-fraud pattern; we'd rather force a human
// to look at it.
const AUTO_ATTACH_BLOCKING_TIERS = new Set<SpamReport['tier']>(['high_risk'])

// File statuses eligible for auto-attach. A funded / recorded / policied /
// cancelled file is considered done — a late-arriving email almost always
// means the sender mis-addressed something or the closing reopened. Either
// way it deserves a human in the loop, so we drop it into triage with a
// suggested file (the prior match) instead of routing on autopilot.
//
// `cleared` and `closing` files are deliberately excluded too: by the time
// they reach those states the team has typically frozen the doc set, so a
// surprise inbound shouldn't silently land. Tighten or loosen this set if
// the workflow shifts.
const AUTO_ATTACH_ELIGIBLE_STATUSES = new Set(['opened', 'in_exam'])

const editorRoles = ['owner', 'admin', 'processor'] as const

const attachmentInputV = v.object({
  filename: v.string(),
  contentType: v.string(),
  sizeBytes: v.number(),
  sha256: v.string(),
  storageId: v.id('_storage'),
  // The HTTP route maps Postmark's `ContentType` header to a docType hint
  // (purchase_agreement, lender_instructions, ...) using filename heuristics.
  // The mutation just forwards it to scheduleExtractionFor.
  docTypeHint: v.optional(v.string()),
})

// ─── Classification ────────────────────────────────────────────────────
// Pure-JS deterministic match. A Claude-backed soft classifier can layer
// on top of this later; for v1 we want the auto-attach decision to be
// auditable from the row alone (no model call).
//
// Confidence scoring (highest wins):
//   filenumber_in_subject  → 0.95  (auto-attach)
//   filenumber_in_body     → 0.90  (auto-attach)
//   address_overlap_full   → ≤0.80 (quarantine; suggested file shown)
//   no_match               → 0.00  (quarantine; no suggestion)

const FILE_NUMBER_PATTERNS: ReadonlyArray<RegExp> = [
  // Vendor-prefixed: "ETT-25-001234"
  /\b([A-Z]{2,4}-\d{2,4}-\d{4,8})\b/gi,
  // "Re: file # 25-001234" — explicit lead-in token
  /(?:file\s*(?:#|no\.?|number)?\s*:?\s*)([A-Z0-9][A-Z0-9-]{3,19})/gi,
  // Bare "25-001234" / "2025-1234" — last so explicit forms win first
  /\b(\d{2,4}-\d{4,8})\b/g,
]

function extractFileNumberCandidates(text: string): Array<string> {
  const seen = new Set<string>()
  for (const re of FILE_NUMBER_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const captured = m[1]
      if (!captured) continue
      const cand = captured.trim().toUpperCase()
      if (cand.length >= 4) seen.add(cand)
    }
  }
  return [...seen]
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Very conservative token-overlap score. Real fuzzy address matching lands
// later (libpostal-style normalization, suite/unit handling, etc.). For v1
// we want predictable behavior: if the file's street name and city both
// appear in the email, we suggest it; otherwise we don't.
const ADDRESS_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'st',
  'street',
  'rd',
  'road',
  'ave',
  'avenue',
  'dr',
  'drive',
  'ln',
  'lane',
  'blvd',
  'boulevard',
  'ct',
  'court',
  'pl',
  'place',
  'pkwy',
  'parkway',
  'suite',
  'ste',
  'apt',
  'unit',
  'of',
  'at',
  'and',
])

function tokenize(s: string): Set<string> {
  return new Set(
    normalize(s)
      .split(' ')
      .filter((t) => t.length >= 3 && !ADDRESS_STOPWORDS.has(t))
  )
}

function scoreAddressMatch(
  haystackTokens: Set<string>,
  address: Doc<'files'>['propertyAddress']
): number {
  if (!address?.line1) return 0
  const needle = tokenize(`${address.line1} ${address.city}`)
  if (needle.size === 0) return 0
  let hit = 0
  for (const t of needle) if (haystackTokens.has(t)) hit++
  return hit / needle.size
}

type ClassifyResult = {
  fileId: Id<'files'> | null
  confidence: number
  reason: string
}

async function classifyEmail(
  ctx: MutationCtx,
  tenantId: Id<'tenants'>,
  inputs: { subject: string; bodyText: string }
): Promise<ClassifyResult> {
  // 1) File number in subject — strongest signal because users explicitly
  // type it when forwarding ("Re: file 25-001234").
  for (const cand of extractFileNumberCandidates(inputs.subject)) {
    const file = await ctx.db
      .query('files')
      .withIndex('by_tenant_filenumber', (q) =>
        q.eq('tenantId', tenantId).eq('fileNumber', cand)
      )
      .unique()
    if (file) {
      return {
        fileId: file._id,
        confidence: 0.95,
        reason: `filenumber_in_subject:${cand}`,
      }
    }
  }

  // 2) File number in body. Slightly lower confidence — could be a quoted
  // reply mentioning multiple files. Still above auto-attach threshold.
  for (const cand of extractFileNumberCandidates(inputs.bodyText)) {
    const file = await ctx.db
      .query('files')
      .withIndex('by_tenant_filenumber', (q) =>
        q.eq('tenantId', tenantId).eq('fileNumber', cand)
      )
      .unique()
    if (file) {
      return {
        fileId: file._id,
        confidence: 0.9,
        reason: `filenumber_in_body:${cand}`,
      }
    }
  }

  // 3) Address overlap. Only considers files opened in the last 180 days
  // and capped at 200 — keeps the scan O(constant) per email regardless of
  // how big the tenant gets. Long-tail older files are still reachable via
  // manual attach in the inbox UI.
  const haystackTokens = tokenize(`${inputs.subject}\n${inputs.bodyText}`)
  const recentCutoff = Date.now() - 180 * 24 * 60 * 60_000
  const candidates = await ctx.db
    .query('files')
    .withIndex('by_tenant_openedAt', (q) =>
      q.eq('tenantId', tenantId).gte('openedAt', recentCutoff)
    )
    .order('desc')
    .take(200)

  let best: { fileId: Id<'files'>; ratio: number } | null = null
  for (const f of candidates) {
    const ratio = scoreAddressMatch(haystackTokens, f.propertyAddress)
    if (ratio > 0.5 && (!best || ratio > best.ratio)) {
      best = { fileId: f._id, ratio }
    }
  }
  if (best) {
    // Cap address-only confidence at 0.8 — below AUTO_ATTACH_CONFIDENCE
    // by design. We surface the suggestion; humans confirm.
    return {
      fileId: best.fileId,
      confidence: Math.min(best.ratio * 0.8, 0.8),
      reason: `address_overlap:${best.ratio.toFixed(2)}`,
    }
  }

  return { fileId: null, confidence: 0, reason: 'no_match' }
}

// ─── Member attribution ────────────────────────────────────────────────
// Documents.uploadedByMemberId is required. For an inbound email we pick
// the tenant's owner (or any active member) — same fallback pattern the
// SoftPro agent path uses.

async function pickAttributionMember(
  ctx: MutationCtx | QueryCtx,
  tenantId: Id<'tenants'>
): Promise<Doc<'tenantMembers'> | null> {
  const members = await ctx.db
    .query('tenantMembers')
    .withIndex('by_tenant_email', (q) => q.eq('tenantId', tenantId))
    .collect()
  return (
    members.find((m) => m.role === 'owner' && m.status === 'active') ??
    members.find((m) => m.status === 'active') ??
    null
  )
}

// ─── Ingest ────────────────────────────────────────────────────────────
// Single-shot mutation: insert the inboundEmails row, run classification,
// create document rows for each attachment, optionally auto-attach + start
// extractions. The HTTP route is responsible for storing the raw .eml +
// each attachment blob and computing sha256s before calling us.

export const _ingestInbound = internalMutation({
  args: {
    integrationId: v.id('integrations'),
    providerMessageId: v.string(),
    fromAddress: v.string(),
    fromName: v.optional(v.string()),
    toAddress: v.string(),
    replyToAddress: v.optional(v.string()),
    subject: v.string(),
    bodyText: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
    receivedAt: v.number(),
    rawStorageId: v.optional(v.id('_storage')),
    attachments: v.array(attachmentInputV),
    // Authentication results — captured upstream from the provider's
    // Authentication-Results header (or equivalent). All optional; the
    // scorer treats absence as "auth_missing" and adds a small penalty.
    spfResult: v.optional(v.string()),
    dkimResult: v.optional(v.string()),
    dmarcResult: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const integration = await ctx.db.get(args.integrationId)
    if (!integration) throw new ConvexError('INTEGRATION_NOT_FOUND')
    if (integration.kind !== 'email_inbound') {
      throw new ConvexError('INTEGRATION_NOT_EMAIL')
    }
    if (integration.status === 'disabled') {
      throw new ConvexError('INTEGRATION_DISABLED')
    }

    // Dedup: same provider message id on the same integration = redelivery.
    // Drop the freshly-stored blobs and return the prior id so the provider
    // sees a 200 and stops retrying.
    const dup = await ctx.db
      .query('inboundEmails')
      .withIndex('by_tenant_message', (q) =>
        q
          .eq('tenantId', integration.tenantId)
          .eq('integrationId', integration._id)
          .eq('providerMessageId', args.providerMessageId)
      )
      .unique()
    if (dup) {
      if (args.rawStorageId) {
        try {
          await ctx.storage.delete(args.rawStorageId)
        } catch {
          /* best-effort */
        }
      }
      for (const a of args.attachments) {
        try {
          await ctx.storage.delete(a.storageId)
        } catch {
          /* best-effort */
        }
      }
      return { inboundEmailId: dup._id, deduped: true }
    }

    if (args.attachments.length > MAX_ATTACHMENTS_PER_EMAIL) {
      // Don't insert — surface as failed at the HTTP layer. Storing 100+
      // documents per email is operator overhead we'd rather flag.
      throw new ConvexError('TOO_MANY_ATTACHMENTS')
    }

    const member = await pickAttributionMember(ctx, integration.tenantId)
    if (!member) throw new ConvexError('NO_ACTIVE_MEMBER')

    // Insert the inbound row up front so the rest of the work has a stable
    // anchor — even if classification throws, the row exists in `failed`
    // status and the processor sees it.
    // Spam / authenticity scoring. Computed once at ingest time off the
    // headers + body the provider gave us; persisted so the UI doesn't
    // need to re-derive it every render. The scorer is deterministic,
    // so re-running it on a re-classify pass yields the same score.
    const spamReport = scoreEmail({
      fromAddress: args.fromAddress,
      fromName: args.fromName ?? null,
      toAddress: args.toAddress,
      replyToAddress: args.replyToAddress ?? null,
      subject: args.subject,
      bodyText: args.bodyText ?? null,
      auth: {
        spf: args.spfResult,
        dkim: args.dkimResult,
        dmarc: args.dmarcResult,
      },
    })

    const inboundEmailId = await ctx.db.insert('inboundEmails', {
      tenantId: integration.tenantId,
      integrationId: integration._id,
      providerMessageId: args.providerMessageId,
      fromAddress: args.fromAddress,
      fromName: args.fromName,
      toAddress: args.toAddress,
      subject: args.subject,
      bodyText: args.bodyText,
      bodyHtml: args.bodyHtml,
      receivedAt: args.receivedAt,
      rawStorageId: args.rawStorageId,
      status: 'classifying',
      attachmentDocumentIds: [],
      attachmentCount: args.attachments.length,
      spamScore: spamReport.score,
      spamTier: spamReport.tier,
      spamSignals: [...spamReport.signals],
      replyToAddress: args.replyToAddress,
      spfResult: args.spfResult,
      dkimResult: args.dkimResult,
      dmarcResult: args.dmarcResult,
    })

    // Classify using subject + body text only. Attachments don't influence
    // routing — the email envelope determines the file, not the contents.
    const classification = await classifyEmail(ctx, integration.tenantId, {
      subject: args.subject,
      bodyText: args.bodyText ?? '',
    })

    // Refuse auto-attach on high-risk mail even when the file-number
    // match is rock solid. A spoofed email with the right file # in the
    // subject is the worst-case wire-fraud pattern — better to force a
    // human eye on it.
    const blockedBySpam = AUTO_ATTACH_BLOCKING_TIERS.has(spamReport.tier)

    // Pull the suggested file's status so we can refuse auto-attach to
    // closed / closing / cancelled files. The match is still surfaced as
    // a quarantine suggestion — only the silent route is blocked.
    let suggestedFileStatus: string | null = null
    if (classification.fileId) {
      const suggestedFile = await ctx.db.get(classification.fileId)
      suggestedFileStatus = suggestedFile?.status ?? null
    }
    const blockedByStatus =
      suggestedFileStatus !== null &&
      !AUTO_ATTACH_ELIGIBLE_STATUSES.has(suggestedFileStatus)

    const autoAttach =
      classification.fileId !== null &&
      classification.confidence >= AUTO_ATTACH_CONFIDENCE &&
      !blockedBySpam &&
      !blockedByStatus
    const attachToFileId = autoAttach ? classification.fileId : null

    // Create documents rows for each attachment. When auto-attached we set
    // fileId immediately and schedule extraction; otherwise we leave fileId
    // undefined so the processor can route the document with one click.
    const now = Date.now()
    const documentIds: Array<Id<'documents'>> = []
    for (const att of args.attachments) {
      const docType = att.docTypeHint ?? guessDocTypeFromFilename(att.filename)
      const documentId = await ctx.db.insert('documents', {
        tenantId: integration.tenantId,
        fileId: attachToFileId ?? undefined,
        docType,
        title: att.filename,
        searchText: buildDocumentSearchText({ title: att.filename, docType }),
        storageId: att.storageId,
        contentType: att.contentType,
        sizeBytes: att.sizeBytes,
        checksum: att.sha256,
        uploadedByMemberId: member._id,
        uploadedAt: now,
      })
      documentIds.push(documentId)

      if (attachToFileId) {
        await scheduleExtractionFor(ctx, integration.tenantId, {
          documentId,
          fileId: attachToFileId,
          storageId: att.storageId,
          docType,
        })
      }
    }

    const matchReason =
      blockedByStatus && suggestedFileStatus
        ? `${classification.reason}; blocked_by_status:${suggestedFileStatus}`
        : classification.reason

    await ctx.db.patch(inboundEmailId, {
      status: autoAttach ? 'auto_attached' : 'quarantined',
      matchedFileId: classification.fileId ?? undefined,
      matchConfidence: classification.confidence,
      matchReason,
      attachmentDocumentIds: documentIds,
      classifiedAt: Date.now(),
    })

    // Schedule the Claude-backed soft classifier to layer intent + reasoning
    // on top of the deterministic match. It runs out-of-band: even if the
    // model is slow or fails, the deterministic auto-attach already happened
    // so the team isn't blocked.
    await ctx.scheduler.runAfter(0, internal.inboundEmailClassifier.run, {
      inboundEmailId,
    })

    // Audit on the file when auto-attached so it appears in the file's
    // activity feed; otherwise audit on the integration (the email isn't
    // tied to a file yet).
    await ctx.db.insert('auditEvents', {
      tenantId: integration.tenantId,
      actorMemberId: member._id,
      actorType: 'webhook',
      action: autoAttach ? 'email.auto_attached' : 'email.quarantined',
      resourceType: autoAttach && attachToFileId ? 'file' : 'integration',
      resourceId: autoAttach && attachToFileId ? attachToFileId : integration._id,
      metadata: {
        inboundEmailId,
        from: args.fromAddress,
        subject: args.subject,
        attachmentCount: args.attachments.length,
        confidence: classification.confidence,
        reason: classification.reason,
      },
      occurredAt: Date.now(),
    })

    // Fan-out to the team. Auto-attaches are an "ok" event (lightweight);
    // quarantines are "warn" because they sit in the queue until a human
    // touches them.
    const sender = args.fromName ? `${args.fromName} <${args.fromAddress}>` : args.fromAddress
    const subjectShort = truncate(args.subject || '(no subject)', 80)
    if (autoAttach && attachToFileId) {
      const file = await ctx.db.get(attachToFileId)
      await fanOutNotification(ctx, integration.tenantId, {
        kind: 'email.auto_attached',
        title: `Email attached → ${file?.fileNumber ?? 'file'}`,
        body: `${sender} · ${subjectShort}`,
        severity: 'ok',
        fileId: attachToFileId,
        actorType: 'webhook',
      })
    } else {
      await fanOutNotification(ctx, integration.tenantId, {
        kind: 'email.quarantined',
        title: 'New email needs triage',
        body: `${sender} · ${subjectShort}`,
        severity: 'warn',
        actorType: 'webhook',
      })
    }

    return {
      inboundEmailId,
      deduped: false,
      autoAttached: autoAttach,
      matchedFileId: classification.fileId,
      confidence: classification.confidence,
    }
  },
})

// Filename-only docType guess. Conservative — falls back to "email_attachment"
// so the extraction runner has a sentinel to branch on, instead of guessing
// "purchase_agreement" for everything.
function guessDocTypeFromFilename(filename: string): string {
  const f = filename.toLowerCase()
  if (/(?:^|[^a-z])(pa|purchase[-_ ]?agreement|contract)/.test(f))
    return 'purchase_agreement'
  if (/counter[-_ ]?offer/.test(f)) return 'counter_offer'
  if (/(?:closing[-_ ]?disclosure|^cd[-_ ]|[-_ ]cd[-_ .])/.test(f))
    return 'closing_disclosure'
  if (/lender|loan[-_ ]?instructions?/.test(f)) return 'lender_instructions'
  if (/title[-_ ]?commitment|commitment/.test(f)) return 'title_commitment'
  if (/buyer[-_ ]?info|buyer[-_ ]?form/.test(f)) return 'buyer_info_form'
  if (/wire[-_ ]?instructions?/.test(f)) return 'wire_instructions'
  if (/payoff/.test(f)) return 'payoff'
  if (/deed/.test(f)) return 'deed'
  return 'email_attachment'
}

// ─── Public surface ────────────────────────────────────────────────────

const inboxStatus = v.union(
  v.literal('pending'),
  v.literal('classifying'),
  v.literal('auto_attached'),
  v.literal('quarantined'),
  v.literal('archived'),
  v.literal('spam'),
  v.literal('failed')
)

export const list = query({
  args: {
    status: v.optional(inboxStatus),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { status, limit }) => {
    const tc = await requireTenant(ctx)
    const take = Math.min(limit ?? 50, 200)
    const rows = status
      ? await ctx.db
          .query('inboundEmails')
          .withIndex('by_tenant_status_received', (q) =>
            q.eq('tenantId', tc.tenantId).eq('status', status)
          )
          .order('desc')
          .take(take)
      : await ctx.db
          .query('inboundEmails')
          .withIndex('by_tenant_received', (q) => q.eq('tenantId', tc.tenantId))
          .order('desc')
          .take(take)

    // Hydrate matched file basics so the table doesn't N+1 client-side.
    const fileIds = new Set<Id<'files'>>()
    for (const r of rows) if (r.matchedFileId) fileIds.add(r.matchedFileId)
    const files = await Promise.all([...fileIds].map((id) => ctx.db.get(id)))
    const fileById = new Map(
      files.filter((f): f is Doc<'files'> => f != null).map((f) => [f._id, f])
    )

    // Fetch a thin slice of each row's attachments so the card can show
    // filename chips without each card making its own roundtrip. Capped
    // at 3 per row — the rest fall under "+ N more" in the UI.
    const attachmentsByRow = new Map<
      Id<'inboundEmails'>,
      Array<{ _id: Id<'documents'>; title: string | null; docType: string }>
    >()
    for (const r of rows) {
      if (r.attachmentDocumentIds.length === 0) {
        attachmentsByRow.set(r._id, [])
        continue
      }
      const sliced = r.attachmentDocumentIds.slice(0, 3)
      const docs = await Promise.all(sliced.map((id) => ctx.db.get(id)))
      attachmentsByRow.set(
        r._id,
        docs
          .filter((d): d is Doc<'documents'> => d != null)
          .map((d) => ({
            _id: d._id,
            title: d.title ?? null,
            docType: d.docType,
          }))
      )
    }

    return rows.map((r) => ({
      _id: r._id,
      fromAddress: r.fromAddress,
      fromName: r.fromName ?? null,
      subject: r.subject,
      // Truncated to keep the list payload small — full body lives in the
      // detail Sheet via api.inboundEmail.get.
      bodyPreview: r.bodyText
        ? r.bodyText.replace(/\s+/g, ' ').trim().slice(0, 160)
        : null,
      receivedAt: r.receivedAt,
      status: r.status,
      attachmentCount: r.attachmentCount,
      attachmentsPreview: attachmentsByRow.get(r._id) ?? [],
      matchConfidence: r.matchConfidence ?? null,
      matchReason: r.matchReason ?? null,
      matchedFile: r.matchedFileId
        ? {
            _id: r.matchedFileId,
            fileNumber: fileById.get(r.matchedFileId)?.fileNumber ?? null,
          }
        : null,
      classifiedAt: r.classifiedAt ?? null,
      errorMessage: r.errorMessage ?? null,
      spamScore: r.spamScore ?? null,
      spamTier: r.spamTier ?? null,
      classification: r.classification ?? null,
    }))
  },
})

export const stats = query({
  args: {},
  handler: async (ctx) => {
    const tc = await requireTenant(ctx)
    // Bounded by the per-status take(500). Anything older than the most
    // recent 500 in any one status doesn't roll into the badge — fine for
    // an inbox view; agencies that hold thousands of un-triaged emails
    // have a different problem.
    const counts: Record<string, number> = {}
    for (const status of [
      'pending',
      'classifying',
      'auto_attached',
      'quarantined',
      'archived',
      'spam',
      'failed',
    ] as const) {
      const rows = await ctx.db
        .query('inboundEmails')
        .withIndex('by_tenant_status_received', (q) =>
          q.eq('tenantId', tc.tenantId).eq('status', status)
        )
        .take(500)
      counts[status] = rows.length
    }
    return counts
  },
})

export const get = query({
  args: { inboundEmailId: v.id('inboundEmails') },
  handler: async (ctx, { inboundEmailId }) => {
    const tc = await requireTenant(ctx)
    const row = await ctx.db.get(inboundEmailId)
    if (!row || row.tenantId !== tc.tenantId) {
      throw new ConvexError('INBOUND_EMAIL_NOT_FOUND')
    }
    const matchedFile = row.matchedFileId
      ? await ctx.db.get(row.matchedFileId)
      : null
    const docs = await Promise.all(
      row.attachmentDocumentIds.map((id) => ctx.db.get(id))
    )
    return {
      _id: row._id,
      fromAddress: row.fromAddress,
      fromName: row.fromName ?? null,
      toAddress: row.toAddress,
      subject: row.subject,
      bodyText: row.bodyText ?? null,
      bodyHtml: row.bodyHtml ?? null,
      receivedAt: row.receivedAt,
      status: row.status,
      matchConfidence: row.matchConfidence ?? null,
      matchReason: row.matchReason ?? null,
      matchedFile:
        matchedFile && matchedFile.tenantId === tc.tenantId
          ? {
              _id: matchedFile._id,
              fileNumber: matchedFile.fileNumber,
              propertyAddress: matchedFile.propertyAddress ?? null,
            }
          : null,
      attachments: docs
        .filter((d): d is Doc<'documents'> => d != null && d.tenantId === tc.tenantId)
        .map((d) => ({
          _id: d._id,
          docType: d.docType,
          title: d.title ?? null,
          sizeBytes: d.sizeBytes ?? null,
          contentType: d.contentType ?? null,
          fileId: d.fileId ?? null,
        })),
      classifiedAt: row.classifiedAt ?? null,
      errorMessage: row.errorMessage ?? null,
      spamScore: row.spamScore ?? null,
      spamTier: row.spamTier ?? null,
      spamSignals: row.spamSignals ?? [],
      replyToAddress: row.replyToAddress ?? null,
      auth: {
        spf: row.spfResult ?? null,
        dkim: row.dkimResult ?? null,
        dmarc: row.dmarcResult ?? null,
      },
      classification: row.classification ?? null,
    }
  },
})

// Manual attach: processor picks a file for a quarantined email and we
// patch each attachment's fileId + start its extraction. Idempotent for
// already-attached attachments — they keep their existing fileId.
export const attachToFile = mutation({
  args: {
    inboundEmailId: v.id('inboundEmails'),
    fileId: v.id('files'),
    // Override token. Required when the email is in a blocking spam tier
    // (high_risk). The UI only sets it after the operator clicks an
    // explicit "I've verified this — attach anyway" affordance. The
    // override is recorded in the audit trail for the file.
    acknowledgeSpamRisk: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { inboundEmailId, fileId, acknowledgeSpamRisk }
  ) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)

    const row = await ctx.db.get(inboundEmailId)
    if (!row || row.tenantId !== tc.tenantId) {
      throw new ConvexError('INBOUND_EMAIL_NOT_FOUND')
    }
    if (row.status === 'archived' || row.status === 'spam') {
      throw new ConvexError('INBOUND_EMAIL_NOT_TRIAGABLE')
    }

    // High-risk authentication failures are the worst-case wire-fraud
    // pattern: a spoofed sender that looks like a real correspondent.
    // Refuse to attach unless the operator explicitly acknowledges the
    // risk. Same threshold as auto-attach so the manual path can never be
    // looser than the automated one.
    const blockedBySpam = AUTO_ATTACH_BLOCKING_TIERS.has(
      (row.spamTier ?? 'clean') as SpamReport['tier']
    )
    if (blockedBySpam && !acknowledgeSpamRisk) {
      throw new ConvexError('INBOUND_EMAIL_BLOCKED_BY_RISK')
    }

    const file = await ctx.db.get(fileId)
    if (!file || file.tenantId !== tc.tenantId) {
      throw new ConvexError('FILE_NOT_FOUND')
    }

    let scheduled = 0
    for (const docId of row.attachmentDocumentIds) {
      const doc = await ctx.db.get(docId)
      if (!doc || doc.tenantId !== tc.tenantId) continue
      if (doc.fileId === fileId) continue
      await ctx.db.patch(docId, { fileId })
      await scheduleExtractionFor(ctx, tc.tenantId, {
        documentId: docId,
        fileId,
        storageId: doc.storageId,
        docType: doc.docType,
      })
      scheduled++
    }

    await ctx.db.patch(inboundEmailId, {
      status: 'auto_attached',
      matchedFileId: fileId,
      matchConfidence: 1,
      matchReason: blockedBySpam
        ? 'manual_attach_high_risk_override'
        : 'manual_attach',
      classifiedAt: Date.now(),
    })

    await recordAudit(ctx, tc, 'email.manual_attached', 'file', fileId, {
      inboundEmailId,
      attachmentsScheduled: scheduled,
      spamTier: row.spamTier ?? null,
      spamScore: row.spamScore ?? null,
      riskOverride: blockedBySpam,
    })

    // Light notification — confirms a triage decision flowed through, and
    // gives processors elsewhere on the team a hint a previously-pending
    // row is now resolved. High-risk overrides escalate to a `block`
    // severity so a teammate immediately notices someone bypassed the
    // wire-fraud guard.
    await fanOutNotification(ctx, tc.tenantId, {
      kind: blockedBySpam
        ? 'email.manual_attached_high_risk'
        : 'email.manual_attached',
      title: blockedBySpam
        ? `High-risk email manually attached to ${file.fileNumber}`
        : `Email routed to ${file.fileNumber}`,
      body: blockedBySpam
        ? `Operator overrode the high-risk block — verify before any wire instructions are followed. ${truncate(row.subject || '(no subject)', 80)}`
        : truncate(row.subject || '(no subject)', 80),
      severity: blockedBySpam ? 'block' : 'info',
      fileId,
      actorMemberId: tc.memberId,
      actorType: 'user',
    })

    return {
      ok: true,
      attachmentsScheduled: scheduled,
      riskOverride: blockedBySpam,
    }
  },
})

export const archive = mutation({
  args: { inboundEmailId: v.id('inboundEmails') },
  handler: async (ctx, { inboundEmailId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    const row = await ctx.db.get(inboundEmailId)
    if (!row || row.tenantId !== tc.tenantId) {
      throw new ConvexError('INBOUND_EMAIL_NOT_FOUND')
    }
    await ctx.db.patch(inboundEmailId, { status: 'archived' })
    await recordAudit(
      ctx,
      tc,
      'email.archived',
      'integration',
      row.integrationId,
      { inboundEmailId, from: row.fromAddress, subject: row.subject }
    )
    return { ok: true }
  },
})

export const markSpam = mutation({
  args: { inboundEmailId: v.id('inboundEmails') },
  handler: async (ctx, { inboundEmailId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    const row = await ctx.db.get(inboundEmailId)
    if (!row || row.tenantId !== tc.tenantId) {
      throw new ConvexError('INBOUND_EMAIL_NOT_FOUND')
    }
    await ctx.db.patch(inboundEmailId, { status: 'spam' })
    await recordAudit(
      ctx,
      tc,
      'email.marked_spam',
      'integration',
      row.integrationId,
      { inboundEmailId, from: row.fromAddress }
    )
    return { ok: true }
  },
})

// Hard-delete an inbound email. Drops the row + the raw envelope blob.
// Cascade rule for attachments:
//   • Document NOT routed to a file (fileId is undefined) → delete the
//     document row + extraction rows + storage blob. Nothing else
//     references it.
//   • Document already routed to a file → leave it. The attachment is
//     part of that file's history now and the file detail page is the
//     authoritative place to delete it.
//
// Returns counts so the UI can surface what changed in the toast.
// Editor-role only — this is the only destructive action on the inbox.
export const remove = mutation({
  args: { inboundEmailId: v.id('inboundEmails') },
  handler: async (ctx, { inboundEmailId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    const row = await ctx.db.get(inboundEmailId)
    if (!row || row.tenantId !== tc.tenantId) {
      throw new ConvexError('INBOUND_EMAIL_NOT_FOUND')
    }

    let documentsDeleted = 0
    let documentsKept = 0
    for (const docId of row.attachmentDocumentIds) {
      const doc = await ctx.db.get(docId)
      if (!doc || doc.tenantId !== tc.tenantId) continue
      if (doc.fileId) {
        // Routed to a file — leave it alone.
        documentsKept++
        continue
      }
      await deleteDocumentCascade(ctx, tc.tenantId, doc)
      documentsDeleted++
    }

    if (row.rawStorageId) {
      try {
        await ctx.storage.delete(row.rawStorageId)
      } catch {
        // best-effort — the row goes regardless
      }
    }

    await ctx.db.delete(inboundEmailId)

    await recordAudit(
      ctx,
      tc,
      'email.deleted',
      'integration',
      row.integrationId,
      {
        inboundEmailId,
        from: row.fromAddress,
        subject: row.subject,
        priorStatus: row.status,
        documentsDeleted,
        documentsKept,
      }
    )

    return { ok: true, documentsDeleted, documentsKept }
  },
})

// ─── Provider routing ──────────────────────────────────────────────────
//
// The shared `/integrations/email/postmark` HTTP route uses this to map
// the inbound email's mailbox hash (the `+suffix` Postmark surfaces in the
// `MailboxHash` field) onto a specific tenant + integration. Returns null
// if no email_inbound integration is configured for that localpart.

export const _findEmailInboundByLocalpart = internalQuery({
  args: { localpart: v.string() },
  handler: async (ctx, { localpart }) => {
    const normalized = localpart.trim().toLowerCase()
    if (!normalized) return null

    // Linear scan over the integrations table, then JS-filter to
    // email_inbound. The table grows slowly (one row per source per
    // tenant) so a single bounded read with .take(500) is safe today.
    // If/when the deployment-wide row count crosses the bound we'll
    // hoist `emailLocalpart` to a top-level field with its own index.
    const all = await ctx.db.query('integrations').take(500)
    const integrations = all.filter((r) => r.kind === 'email_inbound')

    for (const row of integrations) {
      const cfg = row.config as
        | { forwardAddressLocalPart?: string }
        | null
        | undefined
      const lp = cfg?.forwardAddressLocalPart?.toLowerCase()
      if (lp === normalized) {
        return {
          integrationId: row._id,
          tenantId: row.tenantId,
          status: row.status,
        }
      }
    }

    // Fallback: localpart can equal the integration id itself for tenants
    // that haven't customized their forwardAddressLocalPart. The admin UI
    // surfaces this format ("mail-<integrationId>@inbound.titlehub.app").
    for (const row of integrations) {
      if (row._id.toLowerCase() === normalized) {
        return {
          integrationId: row._id,
          tenantId: row.tenantId,
          status: row.status,
        }
      }
    }

    return null
  },
})

// ─── Classifier (Claude-backed) helpers ────────────────────────────────
//
// The Node-side classifier action lives in inboundEmailClassifier.ts so it
// can pull the Anthropic SDK in. These two helpers are its database
// boundary: one query to load context, one mutation to apply the result.
// Both are tenant-scoped via the row's tenantId — the classifier never
// authenticates as a user.

const classifierIntents = v.union(
  v.literal('wire_instructions'),
  v.literal('payoff'),
  v.literal('title_commitment'),
  v.literal('closing_disclosure'),
  v.literal('county_response'),
  v.literal('buyer_info'),
  v.literal('lender_correspondence'),
  v.literal('title_document'),
  v.literal('marketing'),
  v.literal('phishing'),
  v.literal('other')
)

export const _loadClassifierContext = internalQuery({
  args: { inboundEmailId: v.id('inboundEmails') },
  handler: async (ctx, { inboundEmailId }) => {
    const row = await ctx.db.get(inboundEmailId)
    if (!row) return null
    if (row.classification) {
      // Already classified — re-runs are explicit via a separate path. The
      // action treats this as a no-op signal.
      return null
    }
    const recentCutoff = Date.now() - 90 * 24 * 60 * 60_000
    const candidates = await ctx.db
      .query('files')
      .withIndex('by_tenant_openedAt', (q) =>
        q.eq('tenantId', row.tenantId).gte('openedAt', recentCutoff)
      )
      .order('desc')
      .take(60)
    return {
      tenantId: row.tenantId,
      fromAddress: row.fromAddress,
      fromName: row.fromName ?? null,
      subject: row.subject,
      bodyText: row.bodyText ?? null,
      attachmentCount: row.attachmentCount,
      spamTier: row.spamTier ?? null,
      currentMatchedFileId: row.matchedFileId ?? null,
      currentConfidence: row.matchConfidence ?? 0,
      candidates: candidates.map((f) => ({
        fileId: f._id,
        fileNumber: f.fileNumber,
        propertyAddress: f.propertyAddress ?? null,
      })),
    }
  },
})

export const _applyClassification = internalMutation({
  args: {
    inboundEmailId: v.id('inboundEmails'),
    intent: classifierIntents,
    confidence: v.number(),
    reasons: v.array(v.string()),
    suggestedFileId: v.optional(v.id('files')),
    modelId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { inboundEmailId, intent, confidence, reasons, suggestedFileId, modelId }
  ) => {
    const row = await ctx.db.get(inboundEmailId)
    if (!row) return null

    let suggestedFileNumber: string | undefined
    if (suggestedFileId) {
      const file = await ctx.db.get(suggestedFileId)
      if (!file || file.tenantId !== row.tenantId) {
        // Reject foreign suggestions outright.
        suggestedFileId = undefined
      } else {
        suggestedFileNumber = file.fileNumber
      }
    }

    const classification = {
      intent,
      confidence: Math.max(0, Math.min(1, confidence)),
      reasons: reasons.slice(0, 8),
      suggestedFileId,
      suggestedFileNumber,
      classifiedAt: Date.now(),
      modelId,
    }
    await ctx.db.patch(inboundEmailId, { classification })

    // Auto-escalate: if the email is currently quarantined, the classifier
    // is highly confident, the suggested file is concrete, and spam isn't
    // blocking, attach now. Otherwise leave it for a human.
    const blockedBySpam = AUTO_ATTACH_BLOCKING_TIERS.has(
      (row.spamTier ?? 'clean') as SpamReport['tier']
    )
    const canEscalate =
      row.status === 'quarantined' &&
      !!suggestedFileId &&
      classification.confidence >= AUTO_ATTACH_CONFIDENCE &&
      !blockedBySpam

    if (canEscalate && suggestedFileId) {
      const file = await ctx.db.get(suggestedFileId)
      if (
        file &&
        file.tenantId === row.tenantId &&
        AUTO_ATTACH_ELIGIBLE_STATUSES.has(file.status)
      ) {
        let scheduled = 0
        for (const docId of row.attachmentDocumentIds) {
          const doc = await ctx.db.get(docId)
          if (!doc || doc.tenantId !== row.tenantId) continue
          if (doc.fileId === suggestedFileId) continue
          await ctx.db.patch(docId, { fileId: suggestedFileId })
          await scheduleExtractionFor(ctx, row.tenantId, {
            documentId: docId,
            fileId: suggestedFileId,
            storageId: doc.storageId,
            docType: doc.docType,
          })
          scheduled++
        }
        await ctx.db.patch(inboundEmailId, {
          status: 'auto_attached',
          matchedFileId: suggestedFileId,
          matchConfidence: Math.max(
            row.matchConfidence ?? 0,
            classification.confidence
          ),
          matchReason: `classifier_escalation:${intent}`,
        })
        await ctx.db.insert('auditEvents', {
          tenantId: row.tenantId,
          actorType: 'system',
          action: 'email.classifier_attached',
          resourceType: 'file',
          resourceId: suggestedFileId,
          metadata: {
            inboundEmailId,
            intent,
            confidence: classification.confidence,
            reasons: classification.reasons,
            attachmentsScheduled: scheduled,
            modelId,
          },
          occurredAt: Date.now(),
        })
        const senderLabel = row.fromName
          ? `${row.fromName} <${row.fromAddress}>`
          : row.fromAddress
        await fanOutNotification(ctx, row.tenantId, {
          kind: 'email.classifier_attached',
          title: `${humanIntent(intent)} attached → ${file.fileNumber}`,
          body: `${senderLabel} · ${truncate(row.subject || '(no subject)', 80)}`,
          severity: 'ok',
          fileId: suggestedFileId,
          actorType: 'system',
        })
      }
    } else if (intent === 'wire_instructions' && row.spamTier === 'high_risk') {
      // High-risk wire instructions are the worst-case fraud signal.
      // Surface a blocker even if no escalation happened.
      await fanOutNotification(ctx, row.tenantId, {
        kind: 'email.wire_alert',
        title: 'Possible wire-fraud: review immediately',
        body: `${row.fromAddress} · ${truncate(row.subject || '(no subject)', 80)}`,
        severity: 'block',
        fileId: row.matchedFileId ?? undefined,
        groupKey: `email.wire_alert:${inboundEmailId}`,
        actorType: 'system',
      })
    }

    return classification
  },
})

// Clears the classification so a re-run starts fresh — internal because
// it's only callable from the classifier action.
export const _clearClassification = internalMutation({
  args: { inboundEmailId: v.id('inboundEmails') },
  handler: async (ctx, { inboundEmailId }) => {
    const row = await ctx.db.get(inboundEmailId)
    if (!row) return
    await ctx.db.patch(inboundEmailId, { classification: undefined })
  },
})

// Public: editor-role mutation that asks the classifier to take another
// pass. Useful after a processor adjusts the sender's reputation or after
// a model upgrade — tiny escape hatch, audited.
export const reclassify = mutation({
  args: { inboundEmailId: v.id('inboundEmails') },
  handler: async (ctx, { inboundEmailId }) => {
    const tc = await requireTenant(ctx)
    requireRole(tc, ...editorRoles)
    const row = await ctx.db.get(inboundEmailId)
    if (!row || row.tenantId !== tc.tenantId) {
      throw new ConvexError('INBOUND_EMAIL_NOT_FOUND')
    }
    await ctx.scheduler.runAfter(
      0,
      internal.inboundEmailClassifier._rerun,
      { inboundEmailId }
    )
    await recordAudit(
      ctx,
      tc,
      'email.reclassify_requested',
      'integration',
      row.integrationId,
      { inboundEmailId }
    )
    return { ok: true }
  },
})

function humanIntent(intent: string): string {
  switch (intent) {
    case 'wire_instructions':
      return 'Wire instructions'
    case 'payoff':
      return 'Payoff statement'
    case 'title_commitment':
      return 'Title commitment'
    case 'closing_disclosure':
      return 'Closing disclosure'
    case 'county_response':
      return 'County response'
    case 'buyer_info':
      return 'Buyer info'
    case 'lender_correspondence':
      return 'Lender correspondence'
    case 'title_document':
      return 'Title document'
    case 'marketing':
      return 'Marketing'
    case 'phishing':
      return 'Phishing'
    default:
      return 'Email'
  }
}

// ─── Internal helpers used by the inbound HTTP route ───────────────────

export const _markFailed = internalMutation({
  args: {
    integrationId: v.id('integrations'),
    providerMessageId: v.string(),
    fromAddress: v.string(),
    toAddress: v.string(),
    subject: v.string(),
    receivedAt: v.number(),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const integration = await ctx.db.get(args.integrationId)
    if (!integration) return
    if (integration.kind !== 'email_inbound') return

    // Avoid duplicating the failure row if the same message id already has
    // one (provider retried after a partial failure).
    const dup = await ctx.db
      .query('inboundEmails')
      .withIndex('by_tenant_message', (q) =>
        q
          .eq('tenantId', integration.tenantId)
          .eq('integrationId', integration._id)
          .eq('providerMessageId', args.providerMessageId)
      )
      .unique()
    if (dup) return

    await ctx.db.insert('inboundEmails', {
      tenantId: integration.tenantId,
      integrationId: integration._id,
      providerMessageId: args.providerMessageId,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      subject: args.subject,
      receivedAt: args.receivedAt,
      status: 'failed',
      attachmentDocumentIds: [],
      attachmentCount: 0,
      errorMessage: args.errorMessage,
    })

    // Failures are rare and high-signal — fan out as `block` so the bell
    // pulls attention. Operators investigate via the Failed tab on /mail.
    await fanOutNotification(ctx, integration.tenantId, {
      kind: 'email.failed',
      title: 'Inbound email failed to ingest',
      body: `${args.fromAddress} · ${truncate(args.errorMessage, 120)}`,
      severity: 'block',
      actorType: 'webhook',
    })
  },
})
