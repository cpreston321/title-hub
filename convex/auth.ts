import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { magicLink } from "better-auth/plugins/magic-link";
import { organization } from "better-auth/plugins/organization";
import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import authConfig from "./auth.config";
import { components, internal } from "./_generated/api";
import { internalQuery, query } from "./_generated/server";
import type { DataModel } from "./_generated/dataModel";
import type { GenericActionCtx, GenericQueryCtx } from "convex/server";
import { v } from "convex/values";
import authSchema from "./betterAuth/schema";
import { magicLinkEmail, passwordResetEmail, verificationEmail } from "./email";

const siteUrl = process.env.SITE_URL!;

const env = (key: string) => {
  const v = process.env[key];
  return v && v.length > 0 ? v : undefined;
};

function socialProviders() {
  const out: Record<string, { clientId: string; clientSecret: string }> = {};

  const googleId = env("GOOGLE_CLIENT_ID");
  const googleSecret = env("GOOGLE_CLIENT_SECRET");
  if (googleId && googleSecret) {
    out.google = { clientId: googleId, clientSecret: googleSecret };
  }

  const msId = env("MICROSOFT_CLIENT_ID");
  const msSecret = env("MICROSOFT_CLIENT_SECRET");
  if (msId && msSecret) {
    out.microsoft = { clientId: msId, clientSecret: msSecret };
  }

  return out;
}

type EmailArgs = { to: string; subject: string; html: string; text?: string };

function scheduleEmail(ctx: GenericCtx<DataModel>, args: EmailArgs) {
  const maybeScheduler = (ctx as { scheduler?: { runAfter: Function } })
    .scheduler;
  if (!maybeScheduler) {
    console.warn("[auth] cannot send email from query context");
    return;
  }
  return (
    maybeScheduler.runAfter as (
      ms: number,
      ref: typeof internal.email.send,
      args: EmailArgs,
    ) => Promise<unknown>
  )(0, internal.email.send, args);
}

// Provisioning is done in `convex/authTriggers.ts` which dispatches by model.
// The cast on `authFunctions` breaks a TypeScript inference cycle: createClient
// needs the FunctionReference shapes to infer the component's type, but those
// shapes transitively reference back through _generated/api.
const triggerRefs = internal.authTriggers as unknown as {
  onCreate: import("convex/server").FunctionReference<
    "mutation",
    "internal",
    { doc: unknown; model: string }
  >;
  onUpdate: import("convex/server").FunctionReference<
    "mutation",
    "internal",
    { newDoc: unknown; oldDoc: unknown; model: string }
  >;
  onDelete: import("convex/server").FunctionReference<
    "mutation",
    "internal",
    { doc: unknown; model: string }
  >;
};

export const authComponent = createClient<DataModel, typeof authSchema>(
  components.betterAuth,
  {
    local: { schema: authSchema },
    // Presence here gates whether the component fires our authFunctions
    // callback for that model. Actual provisioning runs in
    // convex/authTriggers.ts which dispatches by model name.
    triggers: {
      organization: { onCreate: async () => {} },
      member: { onCreate: async () => {} },
      user: { onCreate: async () => {} },
    },
    authFunctions: triggerRefs,
  },
);

export const createAuthOptions = (
  ctx: GenericCtx<DataModel>,
): BetterAuthOptions => {
  return {
    baseURL: siteUrl,
    database: authComponent.adapter(ctx),
    trustedOrigins: [siteUrl, "https://titlehub.cpreston.dev"],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      sendResetPassword: async ({
        user,
        url,
      }: {
        user: { email: string };
        url: string;
      }) => {
        await scheduleEmail(ctx, {
          to: user.email,
          ...passwordResetEmail(url),
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({
        user,
        url,
      }: {
        user: { email: string };
        url: string;
      }) => {
        await scheduleEmail(ctx, {
          to: user.email,
          ...verificationEmail(url),
        });
      },
    },
    socialProviders: socialProviders(),
    databaseHooks: {
      session: {
        create: {
          // Preset activeOrganizationId on a freshly-created session so the
          // returning user lands directly on the tenant they last used.
          // Best-effort: if the lookup fails for any reason we just create
          // the session without an active org (the picker takes over).
          before: async (session: { userId?: string }) => {
            try {
              const orgId = (await (
                ctx as GenericActionCtx<DataModel>
              ).runQuery(internal.tenants.lastActiveOrgForUser, {
                betterAuthUserId: session.userId ?? "",
              })) as string | null;
              if (orgId) {
                return { data: { ...session, activeOrganizationId: orgId } };
              }
            } catch {
              // ignore — never block session creation
            }
            return { data: session };
          },
        },
        update: {
          // After Better Auth's setActive writes a new activeOrganizationId,
          // bump tenantMembers.lastLoginAt for that (user, tenant) pair so
          // the next sign-in resolves to the same org.
          after: async (session: {
            userId?: string;
            activeOrganizationId?: string | null;
          }) => {
            const orgId = session.activeOrganizationId;
            const userId = session.userId;
            if (!orgId || !userId) return;
            try {
              await (ctx as GenericActionCtx<DataModel>).runMutation(
                internal.tenants.touchLastActiveOrg,
                { betterAuthUserId: userId, betterAuthOrgId: orgId },
              );
            } catch {
              // ignore — best-effort persistence
            }
          },
        },
      },
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: async (user) => {
          // Only system admins (currently the very first signed-up user)
          // may create new organizations. Non-admins must be invited into
          // an existing org. See convex/authTriggers.ts for bootstrap rule.
          //
          // Better Auth invokes this from the org-create HTTP handler, which
          // is an action-like context — `ctx.db` is undefined here, so we
          // hop into an internal query via `runQuery` to read systemAdmins.
          return await (ctx as GenericActionCtx<DataModel>).runQuery(
            internal.auth.isSystemAdmin,
            {
              betterAuthUserId: user.id,
            },
          );
        },
      }),
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          await scheduleEmail(ctx, {
            to: email,
            ...magicLinkEmail(url),
          });
        },
      }),
      convex({ authConfig }),
    ],
  };
};

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth(createAuthOptions(ctx));
};

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    // Use safeGetAuthUser (returns null when there's no identity) instead of
    // getAuthUser (throws "Unauthenticated"). The sidebar subscribes to this
    // on every authenticated route; with the throwing variant, every brief
    // JWT-handshake gap shows up as a logged ConvexError.
    const user = await authComponent.safeGetAuthUser(ctx);
    return user ?? null;
  },
});

// True iff the given Better Auth user id is in our `systemAdmins` allowlist.
// Tolerates mutation contexts as well as queries — both expose `ctx.db`.
export async function isSystemAdminUserId(
  ctx: GenericQueryCtx<DataModel>,
  betterAuthUserId: string,
): Promise<boolean> {
  const row = await ctx.db
    .query("systemAdmins")
    .withIndex("by_user", (q) => q.eq("betterAuthUserId", betterAuthUserId))
    .unique();
  return !!row;
}

// Internal query wrapper so action/HTTP contexts (e.g. Better Auth callbacks)
// can perform the systemAdmins lookup via ctx.runQuery.
export const isSystemAdmin = internalQuery({
  args: { betterAuthUserId: v.string() },
  handler: async (ctx, { betterAuthUserId }): Promise<boolean> => {
    return await isSystemAdminUserId(ctx, betterAuthUserId);
  },
});
