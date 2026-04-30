import { ConvexError } from "convex/values"
import { internalMutation, mutation, query } from "./_generated/server"

// All 92 Indiana counties (FIPS state 18). Timezone defaults to Eastern; the
// 12 Indiana counties on Central time are flagged below. Source: US Census FIPS.
const EASTERN = "America/Indiana/Indianapolis"
const CENTRAL = "America/Chicago"

const IN_COUNTIES: ReadonlyArray<{
  fipsCode: string
  name: string
  timezone: string
}> = [
  { fipsCode: "18001", name: "Adams", timezone: EASTERN },
  { fipsCode: "18003", name: "Allen", timezone: EASTERN },
  { fipsCode: "18005", name: "Bartholomew", timezone: EASTERN },
  { fipsCode: "18007", name: "Benton", timezone: EASTERN },
  { fipsCode: "18009", name: "Blackford", timezone: EASTERN },
  { fipsCode: "18011", name: "Boone", timezone: EASTERN },
  { fipsCode: "18013", name: "Brown", timezone: EASTERN },
  { fipsCode: "18015", name: "Carroll", timezone: EASTERN },
  { fipsCode: "18017", name: "Cass", timezone: EASTERN },
  { fipsCode: "18019", name: "Clark", timezone: EASTERN },
  { fipsCode: "18021", name: "Clay", timezone: EASTERN },
  { fipsCode: "18023", name: "Clinton", timezone: EASTERN },
  { fipsCode: "18025", name: "Crawford", timezone: EASTERN },
  { fipsCode: "18027", name: "Daviess", timezone: EASTERN },
  { fipsCode: "18029", name: "Dearborn", timezone: EASTERN },
  { fipsCode: "18031", name: "Decatur", timezone: EASTERN },
  { fipsCode: "18033", name: "DeKalb", timezone: EASTERN },
  { fipsCode: "18035", name: "Delaware", timezone: EASTERN },
  { fipsCode: "18037", name: "Dubois", timezone: EASTERN },
  { fipsCode: "18039", name: "Elkhart", timezone: EASTERN },
  { fipsCode: "18041", name: "Fayette", timezone: EASTERN },
  { fipsCode: "18043", name: "Floyd", timezone: EASTERN },
  { fipsCode: "18045", name: "Fountain", timezone: EASTERN },
  { fipsCode: "18047", name: "Franklin", timezone: EASTERN },
  { fipsCode: "18049", name: "Fulton", timezone: EASTERN },
  { fipsCode: "18051", name: "Gibson", timezone: CENTRAL },
  { fipsCode: "18053", name: "Grant", timezone: EASTERN },
  { fipsCode: "18055", name: "Greene", timezone: EASTERN },
  { fipsCode: "18057", name: "Hamilton", timezone: EASTERN },
  { fipsCode: "18059", name: "Hancock", timezone: EASTERN },
  { fipsCode: "18061", name: "Harrison", timezone: EASTERN },
  { fipsCode: "18063", name: "Hendricks", timezone: EASTERN },
  { fipsCode: "18065", name: "Henry", timezone: EASTERN },
  { fipsCode: "18067", name: "Howard", timezone: EASTERN },
  { fipsCode: "18069", name: "Huntington", timezone: EASTERN },
  { fipsCode: "18071", name: "Jackson", timezone: EASTERN },
  { fipsCode: "18073", name: "Jasper", timezone: CENTRAL },
  { fipsCode: "18075", name: "Jay", timezone: EASTERN },
  { fipsCode: "18077", name: "Jefferson", timezone: EASTERN },
  { fipsCode: "18079", name: "Jennings", timezone: EASTERN },
  { fipsCode: "18081", name: "Johnson", timezone: EASTERN },
  { fipsCode: "18083", name: "Knox", timezone: EASTERN },
  { fipsCode: "18085", name: "Kosciusko", timezone: EASTERN },
  { fipsCode: "18087", name: "LaGrange", timezone: EASTERN },
  { fipsCode: "18089", name: "Lake", timezone: CENTRAL },
  { fipsCode: "18091", name: "LaPorte", timezone: CENTRAL },
  { fipsCode: "18093", name: "Lawrence", timezone: EASTERN },
  { fipsCode: "18095", name: "Madison", timezone: EASTERN },
  { fipsCode: "18097", name: "Marion", timezone: EASTERN },
  { fipsCode: "18099", name: "Marshall", timezone: EASTERN },
  { fipsCode: "18101", name: "Martin", timezone: EASTERN },
  { fipsCode: "18103", name: "Miami", timezone: EASTERN },
  { fipsCode: "18105", name: "Monroe", timezone: EASTERN },
  { fipsCode: "18107", name: "Montgomery", timezone: EASTERN },
  { fipsCode: "18109", name: "Morgan", timezone: EASTERN },
  { fipsCode: "18111", name: "Newton", timezone: CENTRAL },
  { fipsCode: "18113", name: "Noble", timezone: EASTERN },
  { fipsCode: "18115", name: "Ohio", timezone: EASTERN },
  { fipsCode: "18117", name: "Orange", timezone: EASTERN },
  { fipsCode: "18119", name: "Owen", timezone: EASTERN },
  { fipsCode: "18121", name: "Parke", timezone: EASTERN },
  { fipsCode: "18123", name: "Perry", timezone: CENTRAL },
  { fipsCode: "18125", name: "Pike", timezone: CENTRAL },
  { fipsCode: "18127", name: "Porter", timezone: CENTRAL },
  { fipsCode: "18129", name: "Posey", timezone: CENTRAL },
  { fipsCode: "18131", name: "Pulaski", timezone: CENTRAL },
  { fipsCode: "18133", name: "Putnam", timezone: EASTERN },
  { fipsCode: "18135", name: "Randolph", timezone: EASTERN },
  { fipsCode: "18137", name: "Ripley", timezone: EASTERN },
  { fipsCode: "18139", name: "Rush", timezone: EASTERN },
  { fipsCode: "18141", name: "St. Joseph", timezone: EASTERN },
  { fipsCode: "18143", name: "Scott", timezone: EASTERN },
  { fipsCode: "18145", name: "Shelby", timezone: EASTERN },
  { fipsCode: "18147", name: "Spencer", timezone: CENTRAL },
  { fipsCode: "18149", name: "Starke", timezone: CENTRAL },
  { fipsCode: "18151", name: "Steuben", timezone: EASTERN },
  { fipsCode: "18153", name: "Sullivan", timezone: EASTERN },
  { fipsCode: "18155", name: "Switzerland", timezone: EASTERN },
  { fipsCode: "18157", name: "Tippecanoe", timezone: EASTERN },
  { fipsCode: "18159", name: "Tipton", timezone: EASTERN },
  { fipsCode: "18161", name: "Union", timezone: EASTERN },
  { fipsCode: "18163", name: "Vanderburgh", timezone: CENTRAL },
  { fipsCode: "18165", name: "Vermillion", timezone: EASTERN },
  { fipsCode: "18167", name: "Vigo", timezone: EASTERN },
  { fipsCode: "18169", name: "Wabash", timezone: EASTERN },
  { fipsCode: "18171", name: "Warren", timezone: EASTERN },
  { fipsCode: "18173", name: "Warrick", timezone: CENTRAL },
  { fipsCode: "18175", name: "Washington", timezone: EASTERN },
  { fipsCode: "18177", name: "Wayne", timezone: EASTERN },
  { fipsCode: "18179", name: "Wells", timezone: EASTERN },
  { fipsCode: "18181", name: "White", timezone: EASTERN },
  { fipsCode: "18183", name: "Whitley", timezone: EASTERN },
]

const UNDERWRITERS: ReadonlyArray<{ code: string; name: string }> = [
  { code: "FATIC", name: "First American Title Insurance Company" },
  { code: "STC", name: "Stewart Title Company" },
  { code: "OR", name: "Old Republic Title" },
  { code: "FNF", name: "Fidelity National Title" },
  { code: "WFG", name: "WFG National Title Insurance Company" },
  { code: "TRG", name: "The Title Resources Group" },
]

const TRANSACTION_TYPES: ReadonlyArray<{
  code: string
  name: string
  requiredDocs: string[]
}> = [
  {
    code: "purchase",
    name: "Purchase",
    requiredDocs: [
      "purchase_agreement",
      "title_search",
      "commitment",
      "closing_disclosure",
    ],
  },
  {
    code: "refi",
    name: "Refinance",
    requiredDocs: ["title_search", "commitment", "closing_disclosure"],
  },
  {
    code: "commercial",
    name: "Commercial",
    requiredDocs: [
      "purchase_agreement",
      "title_search",
      "commitment",
      "entity_resolution",
    ],
  },
  {
    code: "reo",
    name: "REO",
    requiredDocs: ["title_search", "commitment", "vesting_deed"],
  },
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
        timezone: c.timezone,
      })
      countiesCreated++
    }

    let underwritersCreated = 0
    for (const u of UNDERWRITERS) {
      const existing = await ctx.db
        .query("underwriters")
        .withIndex("by_code", (q) => q.eq("code", u.code))
        .unique()
      if (existing) continue
      await ctx.db.insert("underwriters", { code: u.code, name: u.name })
      underwritersCreated++
    }

    let transactionTypesCreated = 0
    for (const tt of TRANSACTION_TYPES) {
      const existing = await ctx.db
        .query("transactionTypes")
        .withIndex("by_code", (q) => q.eq("code", tt.code))
        .unique()
      if (existing) continue
      await ctx.db.insert("transactionTypes", {
        code: tt.code,
        name: tt.name,
        requiredDocs: tt.requiredDocs,
      })
      transactionTypesCreated++
    }

    return {
      stateCreated,
      countiesCreated,
      underwritersCreated,
      transactionTypesCreated,
    }
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

export const listTransactionTypes = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("transactionTypes").take(50)
  },
})

export const listUnderwriters = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("underwriters").take(50)
  },
})

// One-shot dev seed: promote the earliest tenantMember of the only tenant to
// `owner`. Fails loudly if there are zero or multiple tenants so it can't be
// misapplied later. Idempotent — re-running on an already-owner returns
// `alreadyOwner: true` without writing.
export const promoteFirstOwner = internalMutation({
  args: {},
  handler: async (ctx) => {
    const tenants = await ctx.db.query("tenants").take(2)
    if (tenants.length === 0) throw new ConvexError("NO_TENANTS")
    if (tenants.length > 1) throw new ConvexError("MULTIPLE_TENANTS")
    const tenant = tenants[0]

    const members = await ctx.db
      .query("tenantMembers")
      .withIndex("by_tenant_email", (q) => q.eq("tenantId", tenant._id))
      .take(200)
    if (members.length === 0) throw new ConvexError("NO_MEMBERS")
    const firstMember = members.reduce((earliest, m) =>
      m._creationTime < earliest._creationTime ? m : earliest,
    )

    if (firstMember.role === "owner" && firstMember.canViewNpi) {
      return {
        tenantId: tenant._id,
        memberId: firstMember._id,
        email: firstMember.email,
        alreadyOwner: true,
      }
    }

    const previousRole = firstMember.role
    await ctx.db.patch(firstMember._id, { role: "owner", canViewNpi: true })

    await ctx.db.insert("auditEvents", {
      tenantId: tenant._id,
      actorMemberId: firstMember._id,
      actorType: "system",
      action: "member.role_changed",
      resourceType: "member",
      resourceId: firstMember._id,
      metadata: {
        from: previousRole,
        to: "owner",
        reason: "seed.promoteFirstOwner",
      },
      occurredAt: Date.now(),
    })

    return {
      tenantId: tenant._id,
      memberId: firstMember._id,
      email: firstMember.email,
      previousRole,
      alreadyOwner: false,
    }
  },
})
