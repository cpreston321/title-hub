import { v } from 'convex/values'
import { internalAction } from './_generated/server'
import { internal } from './_generated/api'
import { getAdapter, isMockEnv } from './integrations/registry'
import type { FileSnapshot } from './integrations/types'

// Bounded per-run upsert budget. Keeps a single sync run inside Convex's
// per-action limits even when the adapter returns thousands of changed
// files. The runner stores the cursor on success, so a follow-up tick
// (manual or webhook) picks up where this one stopped.
const MAX_FILES_PER_RUN = 200

export const runSync = internalAction({
  args: { runId: v.id('integrationSyncRuns') },
  handler: async (ctx, { runId }) => {
    const loaded = await ctx.runQuery(internal.integrations._loadForRun, {
      runId,
    })
    if (!loaded) return

    const adapter = getAdapter(loaded.kind)

    // Push-mode integrations don't run a server-side sync. Data arrives
    // via the agent endpoints; `runSync` here is a no-op that records the
    // attempt so the dashboard can flag misconfigured triggers.
    if (adapter.mode === 'push') {
      await ctx.runMutation(internal.integrations._markRunFinished, {
        runId,
        success: false,
        filesProcessed: 0,
        filesUpserted: 0,
        errorCount: 1,
        errorSample:
          'push-mode integration — data arrives via agent push, not server pull',
        nextCursor: null,
      })
      return
    }

    // Force mock mode when:
    //   - the global env switch is on (default in dev/test), or
    //   - the integration has no stored credentials.
    // Either way, real network calls are disabled — the adapter returns
    // its stub snapshots so the upsert path still exercises end-to-end.
    const mock = isMockEnv() || !loaded.hasCredentials

    const adapterCtx = {
      config: loaded.config ?? {},
      // Plaintext credentials are not plumbed into Sprint 6 — adapters run
      // in stub mode. When real creds are wired in (Sprint 7+), pull
      // plaintext via an internal-only `secrets._revealForSync` and pass
      // it here. The shape is already supported by the Adapter contract.
      credentials: null,
      mock,
    }

    let filesProcessed = 0
    let filesUpserted = 0
    let errorCount = 0
    let errorSample: string | undefined
    let nextCursor: string | null | undefined

    try {
      const since = loaded.lastSyncAt ?? 0
      const list = await adapter.listChangedSince(
        adapterCtx,
        since,
        loaded.cursor
      )
      nextCursor = list.nextCursor

      const ids = list.externalIds.slice(0, MAX_FILES_PER_RUN)
      for (const externalId of ids) {
        filesProcessed++
        let snapshot: FileSnapshot
        try {
          snapshot = await adapter.fetchFile(adapterCtx, externalId)
        } catch (err) {
          errorCount++
          if (!errorSample) {
            errorSample = `fetchFile(${externalId}): ${
              err instanceof Error ? err.message : String(err)
            }`
          }
          continue
        }

        try {
          const upsert = (await ctx.runMutation(
            internal.integrations._upsertFileFromSnapshot,
            {
              tenantId: loaded.tenantId,
              integrationKind: loaded.kind,
              snapshot,
            }
          )) as { fileId: string; inserted: boolean }
          if (upsert.inserted) filesUpserted++
        } catch (err) {
          errorCount++
          if (!errorSample) {
            errorSample = `upsert(${externalId}): ${
              err instanceof Error ? err.message : String(err)
            }`
          }
        }
      }

      await ctx.runMutation(internal.integrations._markRunFinished, {
        runId,
        success: errorCount === 0,
        filesProcessed,
        filesUpserted,
        errorCount,
        errorSample,
        nextCursor,
      })
    } catch (err) {
      await ctx.runMutation(internal.integrations._markRunFinished, {
        runId,
        success: false,
        filesProcessed,
        filesUpserted,
        errorCount: errorCount + 1,
        errorSample:
          errorSample ?? (err instanceof Error ? err.message : String(err)),
        nextCursor,
      })
    }
  },
})
