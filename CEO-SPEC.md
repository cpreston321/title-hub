# Title Operations Platform — CEO Memo

**To:** CEO
**From:** Founding team
**Re:** Productizing our internal AI workflow as a SaaS platform for the title industry
**Length:** ~10-minute read

---

## Bottom line up front

We've built an AI workflow inside Easy Title + Quality Title that addresses the eight operational pain points every title agency in the country shares — order entry, vesting, exam, exception triage, knowledge capture, scheduling, funding/fraud, and recording/policy. The same software, packaged as a multi-tenant SaaS, can be sold to other agencies in every state and county. We're asking for approval to spin this up as a productization effort with a defined budget, a 6-month path to pilot revenue, and a clear go/no-go decision point at month 9.

The case rests on four facts:

1. **We are our own first customer.** Two real agencies running on the platform from day one, with documented pain it solves. No customer-discovery risk on the wedge product.
2. **The market is large and consolidating around technology.** The U.S. title insurance industry runs ~$17B in annual premiums and ~6,000+ agencies, and 2026 industry leadership is explicitly betting on technology and efficiency. The window to be the AI-native operations layer is open.
3. **Underwriter distribution is real.** Four underwriters control ~65% of the market. A single co-marketing or technology-partner deal puts us in front of thousands of their agency partners — the cheapest distribution channel in the industry.
4. **The architecture scales without a rewrite.** State and county rules live as versioned data, not code. Onboarding a new county is a content task, not an engineering project.

The ask is summarized in §10.

---

## 1. The opportunity

Title agencies are stuck. Their software stack — SoftPro, Qualia, ResWare, Gmail, county portals, recording vendors, lender portals — is fragmented, and the cost of that fragmentation shows up as re-entry, missed details, customer service load, and tribal knowledge that never escapes a few senior heads. Industry margins are healthy but under pressure from affordability headwinds, fraud risk, and Treasury-driven scrutiny on closing costs. Underwriters are publicly committing to technology and efficiency as their 2026 strategy.

This produces a moment that doesn't come often: a fragmented buyer base, sophisticated enough to see the problem, with no incumbent AI-native workflow product, and a distribution channel (underwriters) that wants to differentiate by giving their agencies better tools.

We are positioned to take this moment because we already know how to operate two agencies, we've already built the workflow that solves the eight pain points, and we have the engineering muscle to productize it.

---

## 2. What we're building

A multi-tenant SaaS platform that sits **alongside** an agency's existing systems — not on top of them, not replacing them. The platform reads from SoftPro/Qualia/ResWare, watches what's happening on every file, and surfaces what humans need to see at the moment they need to see it. Specifically:

- **Catches data integrity problems** before they cause rework — missing names, EIN gaps, conflicting source documents.
- **Reconciles vesting and authority** across the buyer form, purchase agreement, lender docs, and current vesting — flagging mismatches a processor would miss on a busy day.
- **Triages exceptions and judgments**, separating true encumbrances from common-name false positives.
- **Captures expert knowledge** in a structured form so the next processor doesn't need to interrupt Jim or Caryn for every curative situation.
- **Generates recording-ready packages** sized to each county's specific rules.
- **Protects funding workflows** with verification, fraud-pattern detection, and check-mailing controls.

Pricing model: a base platform fee plus per-file usage. This aligns our revenue with the customer's transaction volume, follows how agencies already think about cost, and produces predictable expansion as a customer's volume grows.

---

## 3. Why us, why this, why now

**Why us.** We have two production agencies running the workflow daily. That gives us three things competitors don't have: a working product, real operating data, and proof points for sales conversations. A typical SaaS startup spends 12–18 months and several million dollars getting to "design partner with one customer." We start there.

**Why this.** The eight workstreams in our internal deck are universal pain. Vesting reconciliation, intake data loss, tribal knowledge, recording readiness, fraud controls — every agency in every state has these problems. The deck wasn't written for one company; it was written for the industry.

**Why now.** Three converging factors:

- _Industry tech budgets are opening up._ Underwriter leadership is publicly committing to technology as their 2026 strategy.
- _AI is at a useful capability threshold._ Modern LLMs are reliable enough to extract structured data from purchase agreements, vesting forms, and lender packages with confidence-scored output a human can review. Two years ago they weren't.
- _No incumbent has the wedge._ SoftPro and Qualia are platforms, not AI workflow layers. We don't compete with them; we sit alongside them and make their data useful.

---

## 4. The market

|                                                                  |             |
| ---------------------------------------------------------------- | ----------- |
| **U.S. title insurance industry annual premiums (2025)**         | ~$17B+      |
| **ALTA member organizations (agencies, abstracters, attorneys)** | 6,000+      |
| **Top-4 underwriter market share**                               | ~65%        |
| **Estimated active title agencies (sellable accounts)**          | 6,000–9,000 |
| **Average annual files per mid-market agency (estimated)**       | 1,500–5,000 |

**Serviceable obtainable market (5-year view, illustrative):**
At a blended price of ~$15K/year per agency (platform + usage), 500 agencies = ~$7.5M ARR. 1,500 agencies = ~$22M ARR. The largest agencies and underwriter-tier deals carry 5–10× that ACV, so the upper end of the band is materially higher.

These figures are estimates that need validation as we sell. The shape we're confident in: this is a real vertical SaaS opportunity, not a feature in someone else's product, and not a market that needs to be created — agencies already buy software; we're displacing manual work and adjacent point tools.

---

## 5. How we win — and how we sell

**Three competitive advantages, in order of durability:**

1. **State/county configuration as data.** Title work varies by jurisdiction in ways that make naive products break. Every county has its own recording margins, exhibits, fee schedules, and curative norms. We're building this as a versioned, effective-dated data layer from day one — meaning our 50th customer onboards almost as fast as our 5th. Competitors who hardcode county logic will hit a wall.
2. **Knowledge layer as moat.** Each customer's tribal knowledge stays theirs and creates retention. Our shared/community content layer — county rule packs, common curative templates — gets stronger with every customer added, creating a network effect over time.
3. **AI workflow built around the disconnected reality.** Our explicit design principle: don't make customers re-type information into another tool. Sit alongside their stack and add visibility. This is what every agency we've talked to actually wants and what most software vendors get wrong.

**Distribution strategy:**

- **Direct, founder-led, with our own agencies as case studies** — first 5–10 customers, regional, peer-to-peer.
- **Underwriter partnership** — the unlock. One co-marketing or technology-partner agreement with First American, Fidelity, Stewart, or Old Republic puts us in front of thousands of their agencies. Worth pursuing aggressively starting month 4.
- **State land title associations and ALTA conferences** — proven distribution for vertical SaaS in this industry; not the cheapest channel, but credible.
- **No paid ads, no SDR org for v1.** This industry buys on trust, not search results.

---

## 6. The plan, in three phases

**Phase 1 — Foundation and wedge (months 1–6):** Build the multi-tenant platform, ship the order-entry-integrity feature as the first product surface, onboard Easy Title + Quality Title as production tenants, sign one external pilot. Target by end of month 6: 3 agencies live, $20–40K ARR pilot revenue, signed BAA, foundational compliance posture in place (SOC 2 audit window started).

**Phase 2 — Expand the surface, prove the model (months 7–12):** Add vesting reconciliation, exception triage, and the knowledge center. Stand up SoftPro and Encompass integrations. Onboard 5–10 paying agencies in our home state plus one adjacent state. Begin the underwriter partnership conversation. Target by end of month 12: 10 agencies live, $150–300K ARR, one underwriter pilot in motion.

**Phase 3 — Scale via underwriter and expansion (months 13–24):** Add document assembly, closer scheduling, recording-readiness automation, funding controls. Roll out 5+ states with verified rule packs. Land an underwriter partnership for distribution. Target by end of month 24: 50+ agencies live, $1.5–3M ARR run-rate, SOC 2 Type II report in hand.

The phasing is deliberate: ship the most universal, lowest-configuration capability first (order entry / vesting), then add the high-variance, high-value capabilities (recording, policy) once the configuration framework is exercised.

---

## 7. Team and capital

**Founding team needed for Phase 1 (months 1–6):**

- 1 founding/CTO-level engineer (multi-tenant architecture, integrations)
- 1 full-stack engineer (product surfaces)
- 1 product/design hybrid (workflow design, UX)
- 0.5 paralegal contractor (county rule content)
- 0.25 founder time (sales, partnerships) — first sales is founder sales

**Phase 2 (months 7–12) adds:**

- 1 integrations engineer
- 1 customer success / implementation lead
- 1 sales lead with title industry relationships

**Capital required:**

- Phase 1 budget: approximately $600K–$900K (team + cloud + compliance + tooling). The wide band is honest; final number depends on hiring market and on whether we self-fund engineering from existing operations versus hiring net-new.
- Phase 2 budget: approximately $1.5M–$2.0M, by which point we should have $150K+ in ARR and a credible path to seed/Series A if external capital makes sense.
- Phase 3 budget depends on the underwriter conversation — if a partnership lands, we accelerate; if not, we extend Phase 2 patterns into more states.

**Compliance investment** (across phases): SOC 2 Type II audit (~$30–50K), penetration test (~$15–25K), legal for DPA/BAA templates (~$10–20K), ALTA Best Practices alignment (mostly internal time). All scoped within the budgets above.

---

## 8. Financial picture (illustrative)

Per-file pricing in the industry typically lands in the $5–25/file range depending on capability. We model around a blended ~$15K/agency/year ACV in early years, rising as we add capabilities and as customer file volumes grow.

| Year      | Customers | Avg ACV | ARR      | Notes                           |
| --------- | --------- | ------- | -------- | ------------------------------- |
| End of Y1 | 5–10      | $15K    | $75–150K | Direct founder sales, regional  |
| End of Y2 | 50        | $20K    | ~$1M     | Multi-state; underwriter pilot  |
| End of Y3 | 200       | $25K    | ~$5M     | Underwriter partnership active  |
| End of Y5 | 750       | $30K    | ~$22M    | Multi-product, mid-market depth |

Gross margin on a Convex + Better Auth + AWS stack should run 80%+ at scale. CAC is modest by SaaS standards because the industry buys peer-to-peer and through underwriters, not through paid acquisition. The economics point to a healthy vertical SaaS profile — not a winner-take-all consumer outcome, but a durable, profitable category leader within a defined industry.

These are estimates. They will be wrong. The point of the model is to confirm the opportunity is large enough to be worth pursuing seriously, which it is.

---

## 9. Risks

**The honest list:**

- **Selling cycles in title are slow.** Trust-based purchases, often involving the agency owner personally. Sales cycles of 60–120 days are normal. Mitigation: founder-led sales, peer references, underwriter introductions.
- **Integration complexity is real.** SoftPro, Qualia, ResWare each have their own quirks. We mitigate by building one adapter well (SoftPro) before spreading across the stack, and by treating integrations as a first-class product, not a side project.
- **Regulatory shifts.** Treasury, FinCEN, and state regulators all touch this industry. Recent FinCEN reporting requirements created work for agencies — work we could turn into product, but which also could change scope unpredictably. Mitigation: build the rules engine flexibly, stay close to ALTA.
- **Underwriter partnership timing.** If we don't land an underwriter relationship by month 18, growth slows and we extend phases. Not fatal, but material. Mitigation: parallel direct sales motion that doesn't depend on the partnership.
- **AI extraction quality on edge cases.** Estate files, complex vestings, multi-party commercial deals — the long tail. Mitigation: confidence thresholds, human-in-the-loop on first 90 days, never auto-resolve high-severity findings.
- **Spin-off complexity.** Standing this up as a separate venture creates legal, governance, and IP questions. Mitigation: define structure before hiring; clear IP assignment from the existing entities at the start.

**Risks we're not worried about:**

- _Product-market fit._ We have it. Two agencies are using this daily.
- _Convex/TanStack stack risk._ These are production-grade, SOC 2 + HIPAA, used by serious teams. Real, but bounded.
- _Talent._ TypeScript-end-to-end on a popular stack means we can hire from a wide pool.

---

## 10. The ask

Three decisions:

1. **Approve Phase 1 budget** (approximately $600–900K over months 1–6) and the founding hires.
2. **Approve corporate structure** for the platform venture — most likely a spin-off entity with IP assignment from Easy Title + Quality Title, clean cap table, and a path to outside capital if/when warranted. Recommend involving outside counsel in month 1.
3. **Approve the customer relationship.** Easy Title and Quality Title become the platform's first two production tenants on commercial terms (a friendly rate, but real contracts). This is essential for clean accounting, clean references, and proof that even our friendliest customers are paying customers.

**Decision points after that:**

- _Month 6 go/no-go:_ are we live with 3 paying agencies, with the wedge feature working in production? If yes, fund Phase 2. If no, regroup or wind down.
- _Month 12 go/no-go:_ are we at $150K+ ARR with a credible path to $1M? If yes, evaluate raising external capital to accelerate Phase 3.
- _Month 18 underwriter checkpoint:_ is at least one underwriter partnership in motion? If not, what's the alternative growth lever?

---

## 11. What we'd like to discuss

The areas where your judgment matters most:

- Spin-off vs. internal P&L — strategic and tax implications.
- Capital strategy — self-funded through Phase 1, or raise pre-seed now to move faster?
- Hiring — internal redeployment vs. external hires for the founding engineering roles.
- Underwriter relationships — which of First American, Fidelity, Stewart, Old Republic, or TRG do you have warm paths into, and how aggressive should we be in month 4?

We've prepared a detailed technical design document for the engineering team and a phased product plan; both are available for any depth questions you have. This memo is intentionally short. We'd rather answer your questions live than over-write the case on paper.

---

_End of memo._
