/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import schema from './schema'
import {
  createOrganizationAsUser,
  makeBetterAuthUser,
  registerLocalBetterAuth,
} from './lib/testHelpers'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')
const betterAuthModules = import.meta.glob('./betterAuth/**/*.ts')

async function setup() {
  const t = convexTest(schema, modules)
  registerLocalBetterAuth(t, betterAuthModules)
  await t.mutation(api.seed.indiana, {})

  const alice = await makeBetterAuthUser(t, 'alice@a.example', 'Alice')
  await createOrganizationAsUser(t, alice.userId, alice.sessionId, {
    slug: 'agency-a',
    name: 'Agency A LLC',
  })

  // Create the email_inbound integration via the public mutation so the
  // tenant + audit trail look like prod.
  const { integrationId } = await alice.asUser.mutation(
    api.integrations.create,
    { kind: 'email_inbound', name: 'Inbound mail' }
  )

  // Resolve the Marion county id once — most tests open files there.
  const marionId = await t.run(async (ctx) => {
    const c = await ctx.db
      .query('counties')
      .withIndex('by_fips', (q) => q.eq('fipsCode', '18097'))
      .unique()
    if (!c) throw new Error('Marion county fixture missing')
    return c._id
  })

  return { t, alice, integrationId, marionId }
}

// Convenience: create a real file the classifier can match against.
async function createFile(
  _t: Awaited<ReturnType<typeof setup>>['t'],
  alice: Awaited<ReturnType<typeof setup>>['alice'],
  marionId: Id<'counties'>,
  args: {
    fileNumber: string
    line1?: string
    city?: string
    zip?: string
  }
) {
  return alice.asUser.mutation(api.files.create, {
    fileNumber: args.fileNumber,
    countyId: marionId,
    transactionType: 'purchase',
    propertyAddress:
      args.line1 || args.city
        ? {
            line1: args.line1 ?? '100 Test St',
            city: args.city ?? 'Indianapolis',
            state: 'IN',
            zip: args.zip ?? '46204',
          }
        : undefined,
  })
}

// Build a fake storage blob and return its id. Mirrors what the HTTP route
// does on the inbound path before calling the ingest mutation.
async function putBlob(
  t: Awaited<ReturnType<typeof setup>>['t'],
  body: string
): Promise<Id<'_storage'>> {
  return t.run(async (ctx) =>
    ctx.storage.store(new Blob([body], { type: 'application/pdf' }))
  )
}

type IngestResult = {
  inboundEmailId: Id<'inboundEmails'>
  deduped: boolean
  autoAttached?: boolean
  matchedFileId?: Id<'files'> | null
  confidence?: number
}

describe('inboundEmail — autoscan + attach', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('file number in subject → auto-attach (>= 0.85)', async () => {
    const { t, alice, integrationId, marionId } = await setup()

    const { fileId } = await createFile(t, alice, marionId, {
      fileNumber: '25-001234',
    })

    const storageId = await putBlob(t, 'fake pdf')
    const r = (await t.mutation(internal.inboundEmail._ingestInbound, {
      integrationId,
      providerMessageId: 'msg-1',
      fromAddress: 'agent@example.com',
      toAddress: 'inbox@title.example.com',
      subject: 'Re: file 25-001234 — signed PA',
      bodyText: 'Attached.',
      receivedAt: Date.now(),
      attachments: [
        {
          filename: 'pa.pdf',
          contentType: 'application/pdf',
          sizeBytes: 8,
          sha256: 'a'.repeat(64),
          storageId,
        },
      ],
    })) as IngestResult

    expect(r.deduped).toBe(false)
    expect(r.autoAttached).toBe(true)
    expect(r.matchedFileId).toBe(fileId)
    expect(r.confidence ?? 0).toBeGreaterThanOrEqual(0.85)

    // The attachment is now a documents row pinned to the file with an
    // extraction scheduled.
    const detail = await alice.asUser.query(api.files.get, { fileId })
    expect(detail.documents).toHaveLength(1)
    expect(detail.documents[0]).toMatchObject({
      docType: 'purchase_agreement',
      title: 'pa.pdf',
    })
  })

  test('file number in body → auto-attach', async () => {
    const { t, alice, integrationId, marionId } = await setup()
    const { fileId } = await createFile(t, alice, marionId, {
      fileNumber: '25-009999',
    })

    const r = (await t.mutation(internal.inboundEmail._ingestInbound, {
      integrationId,
      providerMessageId: 'msg-body',
      fromAddress: 'agent@example.com',
      toAddress: 'inbox@title.example.com',
      subject: 'signed docs',
      bodyText: 'Hi, please file under 25-009999. Thanks',
      receivedAt: Date.now(),
      attachments: [],
    })) as IngestResult

    expect(r.autoAttached).toBe(true)
    expect(r.matchedFileId).toBe(fileId)
    expect(r.confidence ?? 0).toBeGreaterThanOrEqual(0.85)
  })

  test('address overlap only → quarantine + suggestion (below auto-threshold)', async () => {
    const { t, alice, integrationId, marionId } = await setup()
    const { fileId } = await createFile(t, alice, marionId, {
      fileNumber: '25-555111',
      line1: '3324 Corey Drive',
      city: 'Indianapolis',
    })

    const r = (await t.mutation(internal.inboundEmail._ingestInbound, {
      integrationId,
      providerMessageId: 'msg-addr',
      fromAddress: 'agent@example.com',
      toAddress: 'inbox@title.example.com',
      subject: 'Property docs attached',
      bodyText: 'Re: 3324 Corey Drive Indianapolis — please update.',
      receivedAt: Date.now(),
      attachments: [],
    })) as IngestResult

    expect(r.autoAttached).toBe(false)
    expect(r.matchedFileId).toBe(fileId)
    expect(r.confidence ?? 0).toBeGreaterThan(0)
    expect(r.confidence ?? 0).toBeLessThan(0.85)

    // The inboundEmails row should be in quarantined status.
    const list = await alice.asUser.query(api.inboundEmail.list, {
      status: 'quarantined',
    })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      status: 'quarantined',
      matchedFile: { _id: fileId },
    })
  })

  test('no match → quarantined, no matchedFile', async () => {
    const { t, integrationId, alice } = await setup()

    const r = (await t.mutation(internal.inboundEmail._ingestInbound, {
      integrationId,
      providerMessageId: 'msg-none',
      fromAddress: 'agent@example.com',
      toAddress: 'inbox@title.example.com',
      subject: 'Hello world',
      bodyText: 'Nothing identifying here.',
      receivedAt: Date.now(),
      attachments: [],
    })) as IngestResult

    expect(r.autoAttached).toBe(false)
    expect(r.matchedFileId).toBeNull()
    const detail = await alice.asUser.query(api.inboundEmail.get, {
      inboundEmailId: r.inboundEmailId,
    })
    expect(detail.status).toBe('quarantined')
    expect(detail.matchedFile).toBeNull()
  })

  test('dedup: same providerMessageId returns the prior row + cleans up blobs', async () => {
    const { t, integrationId, alice, marionId } = await setup()
    await createFile(t, alice, marionId, { fileNumber: '25-DEDUP' })

    const storageId1 = await putBlob(t, 'first body')
    const first = (await t.mutation(internal.inboundEmail._ingestInbound, {
      integrationId,
      providerMessageId: 'dup',
      fromAddress: 'agent@example.com',
      toAddress: 'inbox@title.example.com',
      subject: 'Re: file 25-DEDUP',
      bodyText: '',
      receivedAt: Date.now(),
      attachments: [
        {
          filename: 'a.pdf',
          contentType: 'application/pdf',
          sizeBytes: 4,
          sha256: 'b'.repeat(64),
          storageId: storageId1,
        },
      ],
    })) as IngestResult
    expect(first.deduped).toBe(false)
    expect(first.autoAttached).toBe(true)

    const storageId2 = await putBlob(t, 'redelivered body')
    const second = (await t.mutation(internal.inboundEmail._ingestInbound, {
      integrationId,
      providerMessageId: 'dup',
      fromAddress: 'agent@example.com',
      toAddress: 'inbox@title.example.com',
      subject: 'Re: file 25-DEDUP',
      bodyText: '',
      receivedAt: Date.now(),
      attachments: [
        {
          filename: 'a.pdf',
          contentType: 'application/pdf',
          sizeBytes: 4,
          sha256: 'b'.repeat(64),
          storageId: storageId2,
        },
      ],
    })) as IngestResult

    expect(second.deduped).toBe(true)
    expect(second.inboundEmailId).toBe(first.inboundEmailId)

    // The redelivered storage blob should be gone — dedup cleans up.
    const stillThere = await t.run((ctx) =>
      ctx.db.system.get(storageId2)
    )
    expect(stillThere).toBeNull()
  })

  test('attachToFile patches a quarantined attachment + schedules extraction', async () => {
    const { t, alice, integrationId, marionId } = await setup()
    const { fileId } = await createFile(t, alice, marionId, {
      fileNumber: '25-MANUAL',
    })

    const storageId = await putBlob(t, 'pdf bytes')
    const r = (await t.mutation(internal.inboundEmail._ingestInbound, {
      integrationId,
      providerMessageId: 'msg-manual',
      fromAddress: 'agent@example.com',
      toAddress: 'inbox@title.example.com',
      subject: 'No file number here',
      bodyText: '',
      receivedAt: Date.now(),
      attachments: [
        {
          filename: 'doc.pdf',
          contentType: 'application/pdf',
          sizeBytes: 9,
          sha256: 'c'.repeat(64),
          storageId,
        },
      ],
    })) as IngestResult
    expect(r.autoAttached).toBe(false)

    // Document was created without a fileId.
    const detailBefore = await alice.asUser.query(api.inboundEmail.get, {
      inboundEmailId: r.inboundEmailId,
    })
    expect(detailBefore.attachments[0]).toMatchObject({ fileId: null })

    // Manual attach.
    const out = await alice.asUser.mutation(api.inboundEmail.attachToFile, {
      inboundEmailId: r.inboundEmailId,
      fileId,
    })
    expect(out).toMatchObject({ ok: true, attachmentsScheduled: 1 })

    const fileDetail = await alice.asUser.query(api.files.get, { fileId })
    expect(fileDetail.documents).toHaveLength(1)
    expect(fileDetail.documents[0].title).toBe('doc.pdf')

    const after = await alice.asUser.query(api.inboundEmail.get, {
      inboundEmailId: r.inboundEmailId,
    })
    expect(after.status).toBe('auto_attached')
    expect(after.matchedFile?._id).toBe(fileId)
    expect(after.matchReason).toBe('manual_attach')
  })

  test('archive + markSpam mutations transition status', async () => {
    const { t, alice, integrationId } = await setup()
    const r = (await t.mutation(internal.inboundEmail._ingestInbound, {
      integrationId,
      providerMessageId: 'm-arch',
      fromAddress: 'noise@example.com',
      toAddress: 'inbox@title.example.com',
      subject: 'noise',
      bodyText: '',
      receivedAt: Date.now(),
      attachments: [],
    })) as IngestResult

    await alice.asUser.mutation(api.inboundEmail.archive, {
      inboundEmailId: r.inboundEmailId,
    })
    let row = await alice.asUser.query(api.inboundEmail.get, {
      inboundEmailId: r.inboundEmailId,
    })
    expect(row.status).toBe('archived')

    await alice.asUser.mutation(api.inboundEmail.markSpam, {
      inboundEmailId: r.inboundEmailId,
    })
    row = await alice.asUser.query(api.inboundEmail.get, {
      inboundEmailId: r.inboundEmailId,
    })
    expect(row.status).toBe('spam')
  })

  test('list filters by status; stats reports per-status counts', async () => {
    const { t, alice, integrationId, marionId } = await setup()
    await createFile(t, alice, marionId, { fileNumber: '25-100100' })

    // Auto-attach one.
    await t.mutation(internal.inboundEmail._ingestInbound, {
      integrationId,
      providerMessageId: 'm-a',
      fromAddress: 'a@example.com',
      toAddress: 'inbox@title.example.com',
      subject: 'Re: 25-100100',
      bodyText: '',
      receivedAt: Date.now(),
      attachments: [],
    })
    // Quarantine two.
    for (const id of ['m-q1', 'm-q2']) {
      await t.mutation(internal.inboundEmail._ingestInbound, {
        integrationId,
        providerMessageId: id,
        fromAddress: 'b@example.com',
        toAddress: 'inbox@title.example.com',
        subject: 'no number',
        bodyText: '',
        receivedAt: Date.now(),
        attachments: [],
      })
    }

    const stats = await alice.asUser.query(api.inboundEmail.stats, {})
    expect(stats.auto_attached).toBe(1)
    expect(stats.quarantined).toBe(2)

    const onlyQ = await alice.asUser.query(api.inboundEmail.list, {
      status: 'quarantined',
    })
    expect(onlyQ).toHaveLength(2)
    const onlyA = await alice.asUser.query(api.inboundEmail.list, {
      status: 'auto_attached',
    })
    expect(onlyA).toHaveLength(1)
  })

  test('rejects when the integration kind is not email_inbound', async () => {
    const { t, alice } = await setup()
    const { integrationId: mockId } = await alice.asUser.mutation(
      api.integrations.create,
      { kind: 'mock', name: 'Mock' }
    )
    await expect(
      t.mutation(internal.inboundEmail._ingestInbound, {
        integrationId: mockId,
        providerMessageId: 'oops',
        fromAddress: 'x@example.com',
        toAddress: 'inbox@title.example.com',
        subject: '',
        bodyText: '',
        receivedAt: Date.now(),
        attachments: [],
      })
    ).rejects.toThrow(/INTEGRATION_NOT_EMAIL/)
  })

  test('rejects when the integration is disabled', async () => {
    const { t, alice, integrationId } = await setup()
    await alice.asUser.mutation(api.integrations.setEnabled, {
      integrationId,
      enabled: false,
    })
    await expect(
      t.mutation(internal.inboundEmail._ingestInbound, {
        integrationId,
        providerMessageId: 'd',
        fromAddress: 'x@example.com',
        toAddress: 'inbox@title.example.com',
        subject: '',
        bodyText: '',
        receivedAt: Date.now(),
        attachments: [],
      })
    ).rejects.toThrow(/INTEGRATION_DISABLED/)
  })

  test('rejects > MAX_ATTACHMENTS_PER_EMAIL', async () => {
    const { t, integrationId } = await setup()
    const fakeAttachments = Array.from({ length: 51 }, (_, i) => ({
      filename: `f${i}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 1,
      sha256: i.toString(16).padStart(64, '0'),
      // The mutation rejects before reading these, so a single shared
      // storageId is fine — it would only matter on the dedup branch.
      storageId: undefined as unknown as Id<'_storage'>,
    }))

    // Storage ids must be valid; produce one and reuse so the throw triggers
    // before any of them are dereferenced.
    const sid = await putBlob(t, 'x')
    for (const a of fakeAttachments) a.storageId = sid

    await expect(
      t.mutation(internal.inboundEmail._ingestInbound, {
        integrationId,
        providerMessageId: 'too-many',
        fromAddress: 'a@example.com',
        toAddress: 'inbox@title.example.com',
        subject: 'flood',
        bodyText: '',
        receivedAt: Date.now(),
        attachments: fakeAttachments,
      })
    ).rejects.toThrow(/TOO_MANY_ATTACHMENTS/)
  })

  test('_findEmailInboundByLocalpart resolves by config + falls back to integration id', async () => {
    const { t, integrationId } = await setup()

    // Resolves via the config localpart we wrote in adminGetOrCreate-style
    // (here the integration was created via api.integrations.create which
    // doesn't auto-set forwardAddressLocalPart, so first stamp it):
    await t.run(async (ctx) => {
      await ctx.db.patch(integrationId, {
        config: { forwardAddressLocalPart: 'agency-a' },
      })
    })

    const byConfig = await t.query(
      internal.inboundEmail._findEmailInboundByLocalpart,
      { localpart: 'agency-a' }
    )
    expect(byConfig).toMatchObject({ integrationId })

    // Case-insensitive.
    const byUpper = await t.query(
      internal.inboundEmail._findEmailInboundByLocalpart,
      { localpart: 'AGENCY-A' }
    )
    expect(byUpper).toMatchObject({ integrationId })

    // Falls back to matching the integration id when the config localpart
    // is missing — we clear it then look up by id.
    await t.run(async (ctx) => {
      await ctx.db.patch(integrationId, { config: null })
    })
    const byId = await t.query(
      internal.inboundEmail._findEmailInboundByLocalpart,
      { localpart: integrationId }
    )
    expect(byId).toMatchObject({ integrationId })

    // Unknown → null.
    const miss = await t.query(
      internal.inboundEmail._findEmailInboundByLocalpart,
      { localpart: 'nobody' }
    )
    expect(miss).toBeNull()
  })

  test('fans out a notification per state transition (auto, quarantine, fail, manual)', async () => {
    const { t, alice, integrationId, marionId } = await setup()
    const { fileId } = await createFile(t, alice, marionId, {
      fileNumber: '25-NOTIFY',
    })

    // Auto-attach → severity 'ok'
    await t.mutation(internal.inboundEmail._ingestInbound, {
      integrationId,
      providerMessageId: 'n-auto',
      fromAddress: 'agent@example.com',
      toAddress: 'inbox@title.example.com',
      subject: 'Re: file 25-NOTIFY',
      bodyText: '',
      receivedAt: Date.now(),
      attachments: [],
    })

    // Quarantine → severity 'warn'
    await t.mutation(internal.inboundEmail._ingestInbound, {
      integrationId,
      providerMessageId: 'n-quar',
      fromAddress: 'agent@example.com',
      toAddress: 'inbox@title.example.com',
      subject: 'no number here',
      bodyText: '',
      receivedAt: Date.now(),
      attachments: [],
    })

    // Failure → severity 'block'
    await t.mutation(internal.inboundEmail._markFailed, {
      integrationId,
      providerMessageId: 'n-fail',
      fromAddress: 'broken@example.com',
      toAddress: 'inbox@title.example.com',
      subject: 'failed',
      receivedAt: Date.now(),
      errorMessage: 'attachment_count 51 exceeds limit',
    })

    const feed = await alice.asUser.query(api.notifications.listForMe, {
      limit: 50,
    })
    const kinds = feed.map((n: { kind: string }) => n.kind).sort()
    expect(kinds).toEqual(
      [
        'email.auto_attached',
        'email.failed',
        'email.quarantined',
      ].sort()
    )

    // Manual attach a quarantined row → email.manual_attached.
    const quar = await alice.asUser.query(api.inboundEmail.list, {
      status: 'quarantined',
    })
    expect(quar).toHaveLength(1)
    await alice.asUser.mutation(api.inboundEmail.attachToFile, {
      inboundEmailId: quar[0]._id,
      fileId,
    })

    const feed2 = await alice.asUser.query(api.notifications.listForMe, {
      limit: 50,
    })
    const kinds2 = feed2
      .map((n: { kind: string }) => n.kind)
      .filter((k: string) => k === 'email.manual_attached')
    expect(kinds2).toHaveLength(1)
  })

  test('high_risk spam tier blocks auto-attach even with file # in subject', async () => {
    const { t, alice, integrationId, marionId } = await setup()
    const { fileId } = await createFile(t, alice, marionId, {
      fileNumber: '25-FRAUD',
    })

    // Stack signals: DMARC fail + display-name spoof + reply-to divergence.
    // Subject still names the file # — classifier confidence will be 0.95.
    const r = (await t.mutation(internal.inboundEmail._ingestInbound, {
      integrationId,
      providerMessageId: 'fraud-1',
      fromAddress: 'attacker@evil.example',
      fromName: 'support@chase.com',
      replyToAddress: 'drop@elsewhere.example',
      toAddress: 'inbox@title.example.com',
      subject: 'Re: file 25-FRAUD updated wire instructions',
      bodyText: '',
      receivedAt: Date.now(),
      attachments: [],
      spfResult: 'fail',
      dkimResult: 'fail',
      dmarcResult: 'fail',
    })) as IngestResult

    expect(r.matchedFileId).toBe(fileId)
    expect((r.confidence ?? 0)).toBeGreaterThanOrEqual(0.85)
    // ...but the spam gate forces quarantine.
    expect(r.autoAttached).toBe(false)

    const detail = await alice.asUser.query(api.inboundEmail.get, {
      inboundEmailId: r.inboundEmailId,
    })
    expect(detail.status).toBe('quarantined')
    expect(detail.spamTier).toBe('high_risk')
    expect(detail.spamScore).toBeGreaterThanOrEqual(61)
  })

  test('clean spam score lets auto-attach proceed', async () => {
    const { t, alice, integrationId, marionId } = await setup()
    await createFile(t, alice, marionId, { fileNumber: '25-CLEAN' })

    const r = (await t.mutation(internal.inboundEmail._ingestInbound, {
      integrationId,
      providerMessageId: 'clean-1',
      fromAddress: 'agent@goodbroker.example',
      fromName: 'Jane Agent',
      toAddress: 'inbox@title.example.com',
      subject: 'Re: file 25-CLEAN signed PA',
      bodyText: 'Attached.',
      receivedAt: Date.now(),
      attachments: [],
      spfResult: 'pass',
      dkimResult: 'pass',
      dmarcResult: 'pass',
    })) as IngestResult

    expect(r.autoAttached).toBe(true)
    const detail = await alice.asUser.query(api.inboundEmail.get, {
      inboundEmailId: r.inboundEmailId,
    })
    expect(detail.spamTier).toBe('clean')
  })

  test('remove: deletes the email + cascades attachments that were never routed', async () => {
    const { t, alice, integrationId } = await setup()
    const storageId = await putBlob(t, 'unrouted pdf')
    const r = (await t.mutation(internal.inboundEmail._ingestInbound, {
      integrationId,
      providerMessageId: 'rm-1',
      fromAddress: 'spam@example.com',
      toAddress: 'inbox@title.example.com',
      subject: 'spam',
      bodyText: '',
      receivedAt: Date.now(),
      attachments: [
        {
          filename: 'spam.pdf',
          contentType: 'application/pdf',
          sizeBytes: 5,
          sha256: 'd'.repeat(64),
          storageId,
        },
      ],
    })) as IngestResult

    // Quarantined → attachments live without a fileId.
    const before = await alice.asUser.query(api.inboundEmail.get, {
      inboundEmailId: r.inboundEmailId,
    })
    expect(before.attachments).toHaveLength(1)

    const out = await alice.asUser.mutation(api.inboundEmail.remove, {
      inboundEmailId: r.inboundEmailId,
    })
    expect(out).toMatchObject({
      ok: true,
      documentsDeleted: 1,
      documentsKept: 0,
    })

    // Email gone.
    await expect(
      alice.asUser.query(api.inboundEmail.get, {
        inboundEmailId: r.inboundEmailId,
      })
    ).rejects.toThrow(/INBOUND_EMAIL_NOT_FOUND/)

    // Document gone.
    const doc = await t.run((ctx) => ctx.db.get(before.attachments[0]._id))
    expect(doc).toBeNull()
  })

  test('remove: keeps attachments that were already routed to a file', async () => {
    const { t, alice, integrationId, marionId } = await setup()
    const { fileId } = await createFile(t, alice, marionId, {
      fileNumber: '25-KEEP',
    })
    const storageId = await putBlob(t, 'routed pdf')
    const r = (await t.mutation(internal.inboundEmail._ingestInbound, {
      integrationId,
      providerMessageId: 'rm-2',
      fromAddress: 'agent@example.com',
      toAddress: 'inbox@title.example.com',
      subject: 'Re: file 25-KEEP signed',
      bodyText: '',
      receivedAt: Date.now(),
      attachments: [
        {
          filename: 'pa.pdf',
          contentType: 'application/pdf',
          sizeBytes: 9,
          sha256: 'e'.repeat(64),
          storageId,
        },
      ],
    })) as IngestResult
    expect(r.autoAttached).toBe(true)
    const detail = await alice.asUser.query(api.inboundEmail.get, {
      inboundEmailId: r.inboundEmailId,
    })
    const docId = detail.attachments[0]._id

    const out = await alice.asUser.mutation(api.inboundEmail.remove, {
      inboundEmailId: r.inboundEmailId,
    })
    expect(out).toMatchObject({
      ok: true,
      documentsDeleted: 0,
      documentsKept: 1,
    })

    // Email gone…
    await expect(
      alice.asUser.query(api.inboundEmail.get, {
        inboundEmailId: r.inboundEmailId,
      })
    ).rejects.toThrow(/INBOUND_EMAIL_NOT_FOUND/)

    // …but the document is still on the file.
    const fileDetail = await alice.asUser.query(api.files.get, { fileId })
    expect(fileDetail.documents.map((d) => d._id)).toContain(docId)
  })

  test('remove: requires editor role', async () => {
    const { t, alice, integrationId } = await setup()
    const r = (await t.mutation(internal.inboundEmail._ingestInbound, {
      integrationId,
      providerMessageId: 'rm-3',
      fromAddress: 'x@example.com',
      toAddress: 'inbox@title.example.com',
      subject: '',
      bodyText: '',
      receivedAt: Date.now(),
      attachments: [],
    })) as IngestResult

    // Demote alice to readonly.
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query('tenantMembers')
        .withIndex('by_betterAuthUser', (q) =>
          q.eq('betterAuthUserId', alice.userId)
        )
        .unique()
      if (m) await ctx.db.patch(m._id, { role: 'readonly' })
    })

    await expect(
      alice.asUser.mutation(api.inboundEmail.remove, {
        inboundEmailId: r.inboundEmailId,
      })
    ).rejects.toThrow(/FORBIDDEN/)
  })

  test('cross-tenant isolation: tenant B never sees tenant A inbox', async () => {
    const { t, alice, integrationId } = await setup()
    await t.mutation(internal.inboundEmail._ingestInbound, {
      integrationId,
      providerMessageId: 'iso',
      fromAddress: 'agent@example.com',
      toAddress: 'inbox@title.example.com',
      subject: 'visible to A only',
      bodyText: '',
      receivedAt: Date.now(),
      attachments: [],
    })

    const bob = await makeBetterAuthUser(t, 'bob@b.example', 'Bob')
    await createOrganizationAsUser(t, bob.userId, bob.sessionId, {
      slug: 'agency-b',
      name: 'Agency B LLC',
    })

    const bobList = await bob.asUser.query(api.inboundEmail.list, {})
    expect(bobList).toHaveLength(0)

    const aliceList = await alice.asUser.query(api.inboundEmail.list, {})
    expect(aliceList).toHaveLength(1)
  })
})
