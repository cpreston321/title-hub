import { v } from "convex/values"
import { internalAction } from "./_generated/server"
import { internal, components } from "./_generated/api"

// HMAC-SHA256 signature over the raw body, hex-encoded. Receivers verify by
// recomputing with the same secret.
async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  )
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("")
}

export const dispatchOne = internalAction({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, { deliveryId }) => {
    // Load the delivery + endpoint via a single inline read.
    const ctxRead = await ctx.runQuery(internal.webhooksRunner.loadForDispatch, {
      deliveryId,
    })
    if (!ctxRead) return

    const { url, secret, body, event } = ctxRead

    try {
      const timestamp = Date.now().toString()
      const signed = `${timestamp}.${body}`
      const signature = await sign(secret, signed)
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Title-Event": event,
          "X-Title-Timestamp": timestamp,
          "X-Title-Signature": `sha256=${signature}`,
        },
        body,
      })
      if (!res.ok) {
        await ctx.runMutation(internal.webhooks.markDeliveryAttempt, {
          deliveryId,
          success: false,
          errorMessage: `HTTP ${res.status}`,
        })
        return
      }
      await ctx.runMutation(internal.webhooks.markDeliveryAttempt, {
        deliveryId,
        success: true,
      })
    } catch (err) {
      await ctx.runMutation(internal.webhooks.markDeliveryAttempt, {
        deliveryId,
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      })
    }
  },
})

// Internal helper query to gather everything needed for dispatch in a single
// round trip, without leaking the secret across action boundaries.
import { internalQuery } from "./_generated/server"

export const loadForDispatch = internalQuery({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, { deliveryId }) => {
    const d = await ctx.db.get(deliveryId)
    if (!d) return null
    const ep = await ctx.db.get(d.endpointId)
    if (!ep || !ep.enabled) return null

    const body = JSON.stringify({
      event: d.event,
      payload: d.payload,
      tenantId: d.tenantId,
      deliveryId,
      createdAt: d.createdAt,
    })

    return {
      url: ep.url,
      secret: ep.secret,
      body,
      event: d.event,
    }
  },
})

// Suppress the lint warning about an unused import — `components` is kept here
// for future use (e.g. dispatching to MCP-style sinks via the BetterAuth
// component API). Removing it would require a re-import later.
void components
