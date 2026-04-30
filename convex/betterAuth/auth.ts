/**
 * Re-export so `bunx --bun @better-auth/cli generate --config convex/betterAuth/auth.ts`
 * can introspect the auth options for schema regeneration. NOT used at runtime —
 * the actual auth instance is created in convex/auth.ts.
 */
import { createAuth } from "../auth"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const auth = createAuth({} as any)
