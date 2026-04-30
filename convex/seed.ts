import { mutation, query } from "./_generated/server"

// Minimal Indiana-only seed. Sprint 3 expands this to all 92 IN counties +
// county recording rules.
const IN_COUNTIES: ReadonlyArray<{
  fipsCode: string
  name: string
  recordingOffice?: string
  timezone: string
}> = [
  { fipsCode: "18011", name: "Boone", timezone: "America/Indiana/Indianapolis" },
  { fipsCode: "18057", name: "Hamilton", timezone: "America/Indiana/Indianapolis" },
  { fipsCode: "18063", name: "Hendricks", timezone: "America/Indiana/Indianapolis" },
  { fipsCode: "18081", name: "Johnson", timezone: "America/Indiana/Indianapolis" },
  { fipsCode: "18097", name: "Marion", timezone: "America/Indiana/Indianapolis" },
]

export const indiana = mutation({
  args: {},
  handler: async (ctx) => {
    let stateCreated = 0
    const existingState = await ctx.db
      .query("states")
      .withIndex("by_code", (q) => q.eq("code", "IN"))
      .unique()
    if (!existingState) {
      await ctx.db.insert("states", { code: "IN", name: "Indiana" })
      stateCreated = 1
    }

    let countiesCreated = 0
    for (const c of IN_COUNTIES) {
      const existing = await ctx.db
        .query("counties")
        .withIndex("by_fips", (q) => q.eq("fipsCode", c.fipsCode))
        .unique()
      if (existing) continue
      await ctx.db.insert("counties", {
        fipsCode: c.fipsCode,
        stateCode: "IN",
        name: c.name,
        recordingOffice: c.recordingOffice,
        timezone: c.timezone,
      })
      countiesCreated++
    }

    return { stateCreated, countiesCreated }
  },
})

export const listIndianaCounties = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("counties")
      .withIndex("by_state", (q) => q.eq("stateCode", "IN"))
      .take(200)
  },
})
