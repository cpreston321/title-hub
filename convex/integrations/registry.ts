import { mockAdapter } from './mock'
import { softpro360Adapter } from './softpro360'
import { softproStandardAdapter } from './softproStandard'
import type { Adapter, IntegrationKind } from './types'

// Single source of truth for "which adapters does this build know about".
// New adapters land by adding an entry here. Encompass / Qualia / ResWare
// will follow this pattern in subsequent sprints.
//
// `softpro_standard` is registered but its methods throw — admins can
// reserve a tenant integration row, but `runSync` will fail loudly until
// the transport is picked and the adapter is filled in.
const ADAPTERS: Partial<Record<IntegrationKind, Adapter>> = {
  mock: mockAdapter,
  softpro_360: softpro360Adapter,
  softpro_standard: softproStandardAdapter,
}

export function getAdapter(kind: IntegrationKind): Adapter {
  const a = ADAPTERS[kind]
  if (!a) throw new Error(`ADAPTER_NOT_IMPLEMENTED:${kind}`)
  return a
}

export function listSupportedKinds(): Array<IntegrationKind> {
  return Object.keys(ADAPTERS) as Array<IntegrationKind>
}

// True when the runner should force adapters into stub-network mode. We
// flip this on whenever a real credential has not been wired in, so the
// dashboard works in dev / test without leaking fetches.
export function isMockEnv(): boolean {
  return process.env.INTEGRATIONS_MOCK !== '0'
}
