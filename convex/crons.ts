import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

// Drops terminal-state titleSearchOrders rows (delivered / failed /
// cancelled) past the retention horizon. The documents and auditEvents
// the order produced stay — what's deleted is operational state. The
// purge mutation self-schedules when the batch fills, so a backlog
// drains without waiting a full day.
crons.interval(
  'purge old title search orders',
  { hours: 24 },
  internal.titleSearchOrders.purgeOldOrders,
  {}
)

export default crons
