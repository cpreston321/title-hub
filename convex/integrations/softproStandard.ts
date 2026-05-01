import type { Adapter, FileSnapshot } from './types'

// SoftPro Standard *direct* adapter — for customers running SoftPro
// Standard without the 360 connector. Push-mode: a customer-side agent
// (separate Windows project) posts FileSnapshots to our agent endpoints.
// The server never reaches into the customer's network.
//
// Agent's job:
//   1. Watch the customer's ProForm SQL Server (or COM API, or watched
//      folder) for new/changed orders.
//   2. Map each order onto the FileSnapshot shape.
//   3. POST batches to /integrations/agent/sync, signed with the
//      integration's `inboundSecret`.
//   4. POST a heartbeat to /integrations/agent/heartbeat every minute.
//
// Server's job (this codebase):
//   1. Verify HMAC, upsert snapshots, store the agent's watermark.
//   2. Track heartbeat freshness; surface offline agents in the
//      integrations dashboard.
//
// The Adapter methods below are unreachable in normal flow because the
// runner skips push-mode adapters. They exist as guard rails: if anyone
// wires this kind into a pull-mode path, it fails loudly.

const NOT_PULLABLE = 'SOFTPRO_STANDARD_PUSH_MODE_ONLY'

export const softproStandardAdapter: Adapter = {
  kind: 'softpro_standard',
  mode: 'push',

  // eslint-disable-next-line @typescript-eslint/require-await
  async testConnection() {
    return {
      ok: true,
      detail:
        'push-mode integration — readiness is determined by agent heartbeat freshness',
    }
  },

  // eslint-disable-next-line @typescript-eslint/require-await
  async listChangedSince() {
    throw new Error(NOT_PULLABLE)
  },

  // eslint-disable-next-line @typescript-eslint/require-await
  async fetchFile(): Promise<FileSnapshot> {
    throw new Error(NOT_PULLABLE)
  },
}
