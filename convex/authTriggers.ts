import { v } from "convex/values"
import { internalMutation } from "./_generated/server"
import { internal } from "./_generated/api"

// The Better Auth component dispatches model-specific events here via
// `authFunctions.onCreate/onUpdate/onDelete`. We dispatch by model name and
// fan out to provisioning mutations.
export const onCreate = internalMutation({
  args: { doc: v.any(), model: v.string() },
  handler: async (ctx, { doc, model }) => {
    if (model === "organization") {
      await ctx.runMutation(
        internal.tenants.provisionFromBetterAuthOrg,
        {
          betterAuthOrgId: doc._id,
          slug: doc.slug ?? doc._id,
          legalName: doc.name ?? doc.slug ?? doc._id,
        },
      )
      return
    }
    if (model === "member") {
      await ctx.runMutation(
        internal.tenants.provisionMemberFromBetterAuth,
        {
          betterAuthOrgId: doc.organizationId,
          betterAuthUserId: doc.userId,
          betterAuthRole: doc.role ?? "member",
        },
      )
      return
    }
  },
})

export const onUpdate = internalMutation({
  args: { newDoc: v.any(), oldDoc: v.any(), model: v.string() },
  handler: async () => {
    /* no-op for now; future: sync org rename → tenants.legalName */
  },
})

export const onDelete = internalMutation({
  args: { doc: v.any(), model: v.string() },
  handler: async () => {
    /* no-op for now; future: cascade member removal */
  },
})
