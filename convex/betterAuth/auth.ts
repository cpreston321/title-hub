/**
 * Re-export so `bunx --bun @better-auth/cli generate --config
 * convex/betterAuth/auth.ts` can introspect the auth options for schema
 * regeneration. NOT used at runtime — the actual auth instance is created in
 * convex/auth.ts.
 */
import { createAuth } from '../auth'

export const auth = createAuth({} as any)
