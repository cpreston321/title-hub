/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 *
 * @module
 */

import type * as audit from '../audit.js'
import type * as auth from '../auth.js'
import type * as authTriggers from '../authTriggers.js'
import type * as email from '../email.js'
import type * as extractions from '../extractions.js'
import type * as extractionsRunner from '../extractionsRunner.js'
import type * as files from '../files.js'
import type * as http from '../http.js'
import type * as integrations from '../integrations.js'
import type * as integrations_mock from '../integrations/mock.js'
import type * as integrations_registry from '../integrations/registry.js'
import type * as integrations_softpro360 from '../integrations/softpro360.js'
import type * as integrations_softproStandard from '../integrations/softproStandard.js'
import type * as integrations_types from '../integrations/types.js'
import type * as integrationsRunner from '../integrationsRunner.js'
import type * as lib_audit from '../lib/audit.js'
import type * as lib_crypto from '../lib/crypto.js'
import type * as lib_tenant from '../lib/tenant.js'
import type * as lib_testHelpers from '../lib/testHelpers.js'
import type * as lib_vesting from '../lib/vesting.js'
import type * as notifications from '../notifications.js'
import type * as parties from '../parties.js'
import type * as reconciliation from '../reconciliation.js'
import type * as rules from '../rules.js'
import type * as search from '../search.js'
import type * as secrets from '../secrets.js'
import type * as seed from '../seed.js'
import type * as systemAdmins from '../systemAdmins.js'
import type * as tenants from '../tenants.js'
import type * as webhooks from '../webhooks.js'
import type * as webhooksRunner from '../webhooksRunner.js'

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from 'convex/server'

declare const fullApi: ApiFromModules<{
  audit: typeof audit
  auth: typeof auth
  authTriggers: typeof authTriggers
  email: typeof email
  extractions: typeof extractions
  extractionsRunner: typeof extractionsRunner
  files: typeof files
  http: typeof http
  integrations: typeof integrations
  'integrations/mock': typeof integrations_mock
  'integrations/registry': typeof integrations_registry
  'integrations/softpro360': typeof integrations_softpro360
  'integrations/softproStandard': typeof integrations_softproStandard
  'integrations/types': typeof integrations_types
  integrationsRunner: typeof integrationsRunner
  'lib/audit': typeof lib_audit
  'lib/crypto': typeof lib_crypto
  'lib/tenant': typeof lib_tenant
  'lib/testHelpers': typeof lib_testHelpers
  'lib/vesting': typeof lib_vesting
  notifications: typeof notifications
  parties: typeof parties
  reconciliation: typeof reconciliation
  rules: typeof rules
  search: typeof search
  secrets: typeof secrets
  seed: typeof seed
  systemAdmins: typeof systemAdmins
  tenants: typeof tenants
  webhooks: typeof webhooks
  webhooksRunner: typeof webhooksRunner
}>

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 *
 * ```js
 * const myFunctionReference = api.myModule.myFunction
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, 'public'>
>

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 *
 * ```js
 * const myFunctionReference = internal.myModule.myFunction
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, 'internal'>
>

export declare const components: {
  betterAuth: import('../betterAuth/_generated/component.js').ComponentApi<'betterAuth'>
}
