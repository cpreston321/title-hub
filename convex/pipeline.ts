import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { internal } from './_generated/api'

// Single funnel for "something on this file changed; rerun whatever depends
// on it." Mutations across the codebase schedule this instead of calling
// reconciliation and County Connect directly. Each downstream job records
// its own audit event with trigger: 'auto', so the activity feed already
// shows the cascade — this funnel intentionally writes nothing of its own
// to keep the transaction body minimal (convex-test trips up on a
// db.insert + scheduler.runAfter combo when the parent itself was
// scheduled).
export const reasonV = v.union(
  v.literal('extraction_succeeded'),
  v.literal('file_address_changed'),
  v.literal('file_field_changed'),
  v.literal('party_changed'),
  v.literal('finding_resolved'),
  v.literal('snapshot_stored')
)

export const onFileChange = internalMutation({
  args: {
    tenantId: v.id('tenants'),
    fileId: v.id('files'),
    reason: reasonV,
  },
  handler: async (ctx, { tenantId, fileId, reason }) => {
    const file = await ctx.db.get(fileId)
    if (!file || file.tenantId !== tenantId) return

    await ctx.scheduler.runAfter(0, internal.reconciliation.runForFileAuto, {
      tenantId,
      fileId,
    })

    // The address drives the County Connect ATTOM lookup. When the user
    // edits it, refetch so the propertySnapshots row matches the new address
    // before reconciliation reads it. Each refetch costs an ATTOM call —
    // every other reason re-uses the existing snapshot.
    if (reason === 'file_address_changed') {
      await ctx.scheduler.runAfter(0, internal.countyConnect.runForFileAuto, {
        tenantId,
        fileId,
      })
    }
  },
})
