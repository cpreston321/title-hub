import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { convexQuery } from "@convex-dev/react-query";
import { authClient } from "@/lib/auth-client";
import {
  AlarmClock,
  ArrowRight,
  Bell,
  Building2,
  CalendarClock,
  Check,
  CheckCircle2,
  CircleAlert,
  Eye,
  FileText,
  GitBranch,
  Inbox,
  Layers,
  Loader2,
  Lock,
  Mail,
  Network,
  Plug,
  Plus,
  ScrollText,
  Search,
  ShieldCheck,
  Sparkles,
  Stamp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppShell } from "@/components/app-shell";
import { Loading } from "@/components/loading";
import { DashboardSkeleton } from "@/components/skeletons";
import { toKebabCase } from "@/lib/utils";
import { api } from "../../convex/_generated/api";

export const Route = createFileRoute("/")({
  head: () => {
    const title = "Title Hub — Title operations, made plain.";
    const description =
      "Title Hub is the file-of-record for title agencies: one register for every file, cross-document checks before closing, and versioned recording rules per county. Multi-tenant by construction.";
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: description },
      ],
    };
  },
  // Authenticated users hit this route on every login. Kick the dashboard
  // queries off in the loader so the first paint already has data.
  loader: ({ context }) => {
    const { queryClient, isAuthenticated } = context as {
      queryClient: QueryClient;
      isAuthenticated?: boolean;
    };
    if (!isAuthenticated) return;
    void queryClient.ensureQueryData(convexQuery(api.tenants.current, {}));
    void queryClient.ensureQueryData(convexQuery(api.files.list, {}));
    void queryClient.ensureQueryData(
      convexQuery(api.audit.listForTenant, { limit: 10 }),
    );
  },
  component: App,
});

function App() {
  const { isAuthenticated } = Route.useRouteContext() as {
    isAuthenticated?: boolean;
  };

  if (!isAuthenticated) return <MarketingHome />;
  return <Dashboard />;
}

function MarketingHome() {
  return (
    <div className="relative min-h-svh overflow-x-clip">
      <BackgroundFlourishes />
      <LiveTicker />
      <MarketingTopNav />
      <MarketingHero />
      <ProofRow />
      <MarketingSection
        id="register"
        numeral="I"
        eyebrow="The register"
        title="One register. Every file."
        lede="Click a row to open the docket. Click a stage to filter the trade. Status moves automatically as the work moves — opened, in exam, cleared, closing, funded, recorded, policy issued."
      >
        <LiveRegister />
      </MarketingSection>
      <MarketingSection
        id="reconcile"
        numeral="II"
        eyebrow="Cross-document checks"
        title="Reconcile before you draft."
        lede="Every fact, lined up across every document. Mismatched seller names, miswritten purchase prices, missing signatures — caught at the file, not at the closing table."
      >
        <LiveReconcile />
      </MarketingSection>
      <MarketingSection
        id="closing"
        numeral="III"
        eyebrow="Closing day"
        title="The day, written in advance."
        lede="One screen for every file at the table. Derived items go green automatically; the rest needs an attestation before funds release."
      >
        <LiveClosing />
      </MarketingSection>
      <MarketingSection
        id="mail"
        numeral="IV"
        eyebrow="Mail · queue · orders"
        title="The right work, surfaced."
        lede="Inbound mail auto-classified. Findings, follow-ups, mail triage and orders routed into one ledger. You start where it matters — not where the noise is."
      >
        <QueueAndMailFeature />
      </MarketingSection>
      <MarketingSection
        id="rules"
        numeral="V"
        eyebrow="Recording rules"
        title="A codex per county. Versioned per file."
        lede="Margins, fees, exhibits, notarial requirements — versioned per county and document type. Files in flight always resolve to the rule that was in force when they opened. No retroactive surprises."
      >
        <RulesFeature />
      </MarketingSection>
      <MarketingSection
        id="features"
        numeral="VI"
        eyebrow="Built right"
        title="The trade's quiet machinery."
        lede="The parts you can't see, but every closing depends on."
      >
        <TrustGrid />
      </MarketingSection>
      <MarketingSection
        id="workflow"
        numeral="VII"
        eyebrow="The workflow"
        title="Six steps. Opened to policy."
        lede="The same path every file follows. Each step unlocks the next."
      >
        <WorkflowSteps />
      </MarketingSection>
      <SealCTA />
      <MarketingFooter />
    </div>
  );
}

// ─── Atmosphere ─────────────────────────────────────────────────────────────

function BackgroundFlourishes() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      <div className="absolute inset-0 paper-grain opacity-40" />
      <div className="absolute -top-40 -right-32 size-[40rem] rounded-full bg-[radial-gradient(circle_at_30%_30%,rgba(244,212,143,0.32),transparent_60%)] blur-3xl" />
      <div className="absolute top-[28%] -left-40 size-[32rem] rounded-full bg-[radial-gradient(circle_at_70%_30%,rgba(115,64,112,0.18),transparent_60%)] blur-3xl" />
      <div className="absolute bottom-[-8rem] right-[18%] size-[28rem] rounded-full bg-[radial-gradient(circle_at_30%_60%,rgba(63,124,100,0.14),transparent_60%)] blur-3xl" />
    </div>
  );
}

// ─── Live brass ticker ──────────────────────────────────────────────────────

function LiveTicker() {
  const items: ReadonlyArray<string> = [
    "Live · 7 firms in pilot",
    "312 files of record · this week",
    "Cross-document reconciliation · v2",
    "Recording rules versioned per file",
    "SoftPro 360 · live integration",
    "Last filed · 2m ago · Marion County",
    "Audit trail per file · tenant-scoped",
    "NPI tokens · reveal logged with purpose",
  ];
  const Group = (
    <div className="flex shrink-0 items-center gap-10 px-5">
      {items.map((s, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-2 text-[10px] font-medium tracking-[0.18em] text-[#40233f]/85 uppercase"
        >
          <span className="size-1 rounded-full bg-[#40233f]/70" />
          {s}
        </span>
      ))}
    </div>
  );
  return (
    <div
      role="status"
      aria-label="Latest activity in the trade"
      className="relative overflow-hidden border-b border-[#40233f]/20"
    >
      <div className="brass-foil py-1.5">
        <div className="tk-marquee flex w-max">
          {Group}
          {Group}
        </div>
      </div>
    </div>
  );
}

// ─── Top nav ────────────────────────────────────────────────────────────────

function MarketingTopNav() {
  return (
    <header className="sticky top-0 z-20 border-b border-border/60 bg-background/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1280px] items-center justify-between gap-4 px-6 py-4">
        <Link to="/" className="flex items-center gap-3">
          <BrandMark />
          <div className="leading-tight">
            <div className="font-display text-base font-semibold tracking-tight text-[#40233f]">
              Title Hub
            </div>
            <div className="text-[11px] tracking-[0.04em] text-muted-foreground">
              Operations for the title trade
            </div>
          </div>
        </Link>
        <nav className="hidden items-center gap-6 md:flex">
          <a
            href="#register"
            className="text-sm text-muted-foreground transition hover:text-[#40233f]"
          >
            The register
          </a>
          <a
            href="#reconcile"
            className="text-sm text-muted-foreground transition hover:text-[#40233f]"
          >
            Reconcile
          </a>
          <a
            href="#closing"
            className="text-sm text-muted-foreground transition hover:text-[#40233f]"
          >
            Closing
          </a>
          <a
            href="#features"
            className="text-sm text-muted-foreground transition hover:text-[#40233f]"
          >
            Built right
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to="/signin">Sign in</Link>
          </Button>
          <Button asChild size="sm" className="tk-letterpress gap-1.5">
            <Link to="/signin" search={{ mode: "sign-up" }}>
              Request access
              <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}

// ─── Hero ───────────────────────────────────────────────────────────────────

function MarketingHero() {
  return (
    <section className="relative overflow-hidden border-b border-border/60">
      <div className="relative mx-auto grid w-full max-w-[1280px] grid-cols-1 items-start gap-14 px-6 py-20 lg:grid-cols-[1.05fr_1fr] lg:gap-16 lg:py-28">
        <div className="relative">
          <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-card px-3 py-1 text-[11px] font-semibold tracking-[0.1em] text-[#b78625] shadow-sm uppercase">
            <Sparkles className="size-3.5" />
            Pilot · invite only
          </div>
          <h1 className="mt-6 font-display text-[3.25rem] leading-[0.98] font-semibold tracking-[-0.02em] text-[#40233f] md:text-[4.25rem] lg:text-[5rem]">
            Title operations,
            <br />
            <span className="italic font-[450] text-[#593157]">made plain.</span>
          </h1>
          <div className="mt-6 flex items-center gap-3 text-[#40233f]/70">
            <span className="font-display text-2xl italic">§</span>
            <span className="h-px w-10 bg-[#40233f]/25" />
            <span className="font-numerals text-[10px] font-semibold tracking-[0.32em] uppercase">
              A file-of-record for the trade
            </span>
          </div>
          <p className="tk-drop-cap mt-6 max-w-[36rem] text-[15px] leading-[1.7] text-foreground/80 md:text-[17px]">
            Title Hub gathers the work of a closing onto one page — the
            property, the parties, the documents, the findings, the fees.
            Cross-document reconciliation catches the mismatches before the
            draft. Recording rules are versioned per file, per county. Roles
            gate NPI; the audit trail keeps the file's story straight.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Button
              asChild
              size="lg"
              className="tk-letterpress gap-2 shadow-lg shadow-[#40233f]/15"
            >
              <Link to="/signin">
                Sign in to your tenant
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="tk-letterpress gap-2"
            >
              <Link to="/signin" search={{ mode: "sign-up" }}>
                Request an invitation
              </Link>
            </Button>
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="size-4 text-[#3f7c64]" />
              Audit trail per file
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="size-4 text-[#3f7c64]" />
              NPI gated by role
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="size-4 text-[#3f7c64]" />
              Tenant-scoped data
            </span>
          </div>
        </div>

        <HeroLivePreview />
      </div>
    </section>
  );
}

function HeroLivePreview() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 9999), 3400);
    return () => clearInterval(id);
  }, []);

  const cyclingStatuses = ["in_exam", "cleared", "closing"] as const;
  const currentStatus = cyclingStatuses[tick % cyclingStatuses.length]!;

  const events: ReadonlyArray<{
    actor: string;
    verb: string;
    detail: string;
    tone: "good" | "info" | "amber";
  }> = [
    { actor: "M. Hayes", verb: "ran reconciliation", detail: "all clear", tone: "good" },
    { actor: "System", verb: "extracted commitment", detail: "12 fields", tone: "info" },
    { actor: "T. Reyes", verb: "added party", detail: "Wells Fargo · lender", tone: "info" },
    { actor: "M. Hayes", verb: "advanced to cleared", detail: "ready for closing", tone: "good" },
    { actor: "System", verb: "stamped audit", detail: "doc.uploaded · PA", tone: "amber" },
  ];
  const event = events[tick % events.length]!;

  const baseActive = 28;
  const activeCount = baseActive + (tick % 4);

  return (
    <div className="relative">
      <div
        aria-hidden
        className="tk-halo-drift absolute -inset-10 rounded-[2.5rem] bg-gradient-to-br from-[#fdf6e8] via-[#f6efe4] to-[#f2e7f1] blur-3xl"
      />
      <div className="relative overflow-hidden rounded-3xl border border-[#40233f]/15 bg-card shadow-2xl ring-1 ring-foreground/10">
        {/* Window chrome */}
        <div className="flex items-center justify-between border-b border-border/60 bg-[#fdf6e8]/70 px-5 py-2.5">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-[#b94f58]/55" />
            <span className="size-2 rounded-full bg-[#b78625]/55" />
            <span className="size-2 rounded-full bg-[#3f7c64]/55" />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="relative flex size-2 items-center justify-center">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#3f7c64]/60" />
              <span className="relative inline-flex size-1.5 rounded-full bg-[#3f7c64]" />
            </span>
            <span className="font-numerals text-[9px] tracking-[0.28em] text-muted-foreground uppercase">
              Live
            </span>
          </div>
        </div>

        {/* File header */}
        <div className="border-b border-border/40 px-6 pt-5 pb-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-numerals text-[10px] font-semibold tracking-[0.22em] text-[#b78625] uppercase">
              File · QT-2026-0042
            </span>
            <StatusPillMini key={`hero-${tick}`} status={currentStatus} cycling />
          </div>
          <h3 className="mt-2 font-display text-[26px] leading-[1.1] font-semibold tracking-tight text-[#40233f]">
            1208 N Delaware St
          </h3>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Indianapolis, IN 46202 · Marion County · Purchase
          </div>
        </div>

        {/* KPI strip */}
        <div className="grid grid-cols-4 gap-px bg-border/40">
          <KpiTile
            label="Active"
            value={String(activeCount).padStart(2, "0")}
            tickKey={`active-${activeCount}`}
          />
          <KpiTile label="In exam" value="04" />
          <KpiTile label="Closing 7d" value="02" tone="amber" />
          <KpiTile label="Findings" value="0" tone="good" trailing="all clear" />
        </div>

        {/* Mini files list */}
        <ol className="divide-y divide-border/40">
          {[
            { n: "QT-2026-0041", t: "Refinance", s: "in_exam" as const },
            { n: "QT-2026-0040", t: "Purchase", s: "cleared" as const },
            { n: "QT-2026-0039", t: "Commercial", s: "closing" as const },
            { n: "QT-2026-0038", t: "Purchase", s: "policied" as const },
          ].map((f) => (
            <li
              key={f.n}
              className="grid grid-cols-[6.5rem_1fr_5.5rem] items-center gap-3 px-5 py-2"
            >
              <span className="font-numerals truncate text-[11px] font-medium tracking-tight text-[#2e2430]">
                {f.n}
              </span>
              <span className="text-[11px] text-muted-foreground capitalize">
                {f.t}
              </span>
              <StatusPillMini status={f.s} small />
            </li>
          ))}
        </ol>

        {/* Live event row — remounts on tick so tk-slide-in replays */}
        <div
          key={`evt-${tick}`}
          className="tk-slide-in flex items-start gap-2.5 border-t border-border/40 bg-[#fdf6e8]/40 px-5 py-3"
        >
          <span
            className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full ${
              event.tone === "good"
                ? "bg-[#3f7c64]/15 text-[#2f5d4b]"
                : event.tone === "amber"
                  ? "bg-[#b78625]/15 text-[#7a5818]"
                  : "bg-[#3f668f]/15 text-[#2c4a6b]"
            }`}
          >
            <Sparkles className="size-3" />
          </span>
          <div className="min-w-0 flex-1 text-[11px] leading-snug">
            <span className="font-medium text-[#40233f]">{event.actor}</span>{" "}
            <span className="text-muted-foreground">{event.verb}</span>{" — "}
            <span className="text-foreground/80">{event.detail}</span>
          </div>
          <span className="font-numerals text-[10px] tabular-nums text-muted-foreground">
            just now
          </span>
        </div>
      </div>

      {/* Floating annotations — purely decorative */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-7 top-28 hidden lg:block"
      >
        <FloatingNote tone="green">
          <span className="font-medium text-[#2f5d4b]">Reconciled in 4s</span>
          <ArrowRight className="size-3" />
        </FloatingNote>
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute -right-7 bottom-12 hidden lg:block"
      >
        <FloatingNote tone="amber">
          <Stamp className="size-3" />
          <span className="text-[#7a5818]">Audit · per file</span>
        </FloatingNote>
      </div>
    </div>
  );
}

function KpiTile({
  label,
  value,
  tone,
  trailing,
  tickKey,
}: {
  label: string;
  value: string;
  tone?: "amber" | "good";
  trailing?: string;
  tickKey?: string;
}) {
  const valueClass =
    tone === "good"
      ? "text-[#2f5d4b]"
      : tone === "amber"
        ? "text-[#7a5818]"
        : "text-[#40233f]";
  return (
    <div className="bg-card px-4 py-3.5">
      <div className="text-[10px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
        {label}
      </div>
      <div
        key={tickKey}
        className={`tk-num-tick mt-1 font-display text-[22px] leading-none font-semibold tabular-nums ${valueClass}`}
      >
        {value}
      </div>
      {trailing && (
        <div className="mt-0.5 text-[10px] text-muted-foreground">
          {trailing}
        </div>
      )}
    </div>
  );
}

type FileStatus =
  | "opened"
  | "in_exam"
  | "cleared"
  | "closing"
  | "funded"
  | "recorded"
  | "policied"
  | "cancelled";

function StatusPillMini({
  status,
  small = false,
  cycling = false,
}: {
  status: FileStatus | string;
  small?: boolean;
  cycling?: boolean;
}) {
  const tone =
    status === "policied"
      ? "bg-[#e6f3ed] text-[#2f5d4b] ring-[#3f7c64]/40"
      : status === "closing"
        ? "bg-[#f8eed7] text-[#7a5818] ring-[#b78625]/45"
        : status === "cleared"
          ? "bg-[#e8f0f8] text-[#2c4a6b] ring-[#3f668f]/40"
          : status === "in_exam"
            ? "bg-[#f2e7f1] text-[#40233f] ring-[#593157]/35"
            : "bg-muted text-muted-foreground ring-border";
  const sizing = small
    ? "px-1.5 py-px text-[9px]"
    : "px-2 py-0.5 text-[10px]";
  return (
    <span
      className={`font-numerals inline-flex items-center gap-1 rounded-full font-medium tracking-[0.1em] uppercase ring-1 ring-inset ${tone} ${sizing} ${cycling ? "tk-pill-fade" : ""}`}
    >
      <span className="size-1 rounded-full bg-current" />
      {String(status).replace(/_/g, " ")}
    </span>
  );
}

function FloatingNote({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "green" | "amber";
}) {
  const ring =
    tone === "green"
      ? "ring-[#3f7c64]/30 bg-[#e6f3ed]"
      : "ring-[#b78625]/40 bg-[#fdf6e8]";
  return (
    <div
      className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[10px] font-medium tracking-[0.04em] shadow-md ring-1 ring-inset ${ring}`}
    >
      {children}
    </div>
  );
}

// ─── Proof row (just under hero) ───────────────────────────────────────────

function ProofRow() {
  const stats: ReadonlyArray<{
    figure: string;
    unit?: string;
    label: string;
    note: string;
  }> = [
    { figure: "07", label: "Firms in pilot", note: "across 3 states" },
    { figure: "312", label: "Files this week", note: "opened · examined · closed" },
    { figure: "<5", unit: "s", label: "Median reconcile", note: "across all firms" },
    { figure: "00", label: "Cross-tenant leaks", note: "since Spring 2026" },
  ];
  return (
    <section className="relative border-b border-border/40 bg-[#fdf6e8]/40">
      <div className="mx-auto w-full max-w-[1280px] px-6 py-7">
        <div className="grid grid-cols-2 gap-x-8 gap-y-5 md:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="flex items-baseline gap-3">
              <span className="font-display text-3xl leading-none font-semibold tracking-tight text-[#40233f] tabular-nums md:text-4xl">
                {s.figure}
                {s.unit && (
                  <span className="ml-0.5 text-base font-medium text-[#b78625]">
                    {s.unit}
                  </span>
                )}
              </span>
              <div className="flex flex-col gap-px">
                <span className="text-[11px] font-medium tracking-[0.04em] text-[#40233f]">
                  {s.label}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {s.note}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Section wrapper ───────────────────────────────────────────────────────

function MarketingSection({
  id,
  numeral,
  eyebrow,
  title,
  lede,
  children,
}: {
  id?: string;
  numeral: string;
  eyebrow: string;
  title: string;
  lede?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="relative border-b border-border/40">
      <div className="mx-auto w-full max-w-[1280px] px-6 py-20 lg:py-24">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-16">
          <header className="lg:col-span-5">
            <div className="flex items-baseline gap-3">
              <span
                aria-hidden
                className="font-display text-5xl leading-none font-semibold text-[#b78625]/85 italic"
              >
                {numeral}
              </span>
              <span className="h-px flex-1 bg-[#40233f]/15" />
              <span className="font-numerals text-[10px] font-semibold tracking-[0.32em] text-muted-foreground uppercase">
                §·{eyebrow}
              </span>
            </div>
            <h2 className="mt-6 font-display text-[2.25rem] leading-[1.05] font-semibold tracking-tight text-[#40233f] md:text-[2.75rem]">
              {title}
            </h2>
            {lede && (
              <p className="mt-5 max-w-[28rem] text-[15px] leading-[1.65] text-foreground/75 italic font-display">
                {lede}
              </p>
            )}
          </header>
          <div className="lg:col-span-7">{children}</div>
        </div>
      </div>
    </section>
  );
}

// ─── Section I: The Register ───────────────────────────────────────────────

function LiveRegister() {
  const stages = [
    { id: "opened", label: "Opened", n: 6 },
    { id: "in_exam", label: "In exam", n: 12 },
    { id: "cleared", label: "Cleared", n: 4 },
    { id: "closing", label: "Closing", n: 3 },
    { id: "funded", label: "Funded", n: 2 },
    { id: "recorded", label: "Recorded", n: 1 },
    { id: "policied", label: "Policy", n: 7 },
  ] as const;

  type Row = {
    n: string;
    type: string;
    cnty: string;
    open: string;
    s: FileStatus;
  };
  const allRows: ReadonlyArray<Row> = [
    { n: "QT-2026-0042", type: "Purchase", cnty: "Marion", open: "May 03", s: "in_exam" },
    { n: "QT-2026-0041", type: "Refinance", cnty: "Hamilton", open: "May 02", s: "in_exam" },
    { n: "QT-2026-0040", type: "Purchase", cnty: "Marion", open: "May 02", s: "cleared" },
    { n: "QT-2026-0039", type: "Commercial", cnty: "Hendricks", open: "Apr 30", s: "closing" },
    { n: "QT-2026-0038", type: "Purchase", cnty: "Marion", open: "Apr 30", s: "policied" },
    { n: "QT-2026-0037", type: "Refinance", cnty: "Boone", open: "Apr 29", s: "cleared" },
    { n: "QT-2026-0036", type: "Purchase", cnty: "Marion", open: "Apr 28", s: "closing" },
  ];

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 9999), 5200);
    return () => clearInterval(id);
  }, []);

  const visibleRows = allRows.slice(0, 6);
  const flashIndex = tick % visibleRows.length;

  return (
    <div className="relative">
      <div
        aria-hidden
        className="absolute -inset-6 rounded-[2rem] bg-gradient-to-br from-[#f4d48f]/15 via-transparent to-[#593157]/10 blur-2xl"
      />
      <article className="relative overflow-hidden rounded-2xl bg-card shadow-xl ring-1 ring-foreground/10">
        {/* Pipeline strip */}
        <div className="grid grid-cols-7 gap-px border-b border-border/50 bg-border/40">
          {stages.map((s) => (
            <div
              key={s.id}
              className="flex flex-col gap-0.5 bg-card px-3 py-3"
            >
              <span className="text-[9px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
                {s.label}
              </span>
              <span
                className={`font-display text-[22px] leading-none font-semibold tabular-nums ${s.id === "in_exam" ? "text-[#40233f]" : s.id === "policied" ? "text-[#2f5d4b]" : "text-[#40233f]/70"}`}
              >
                {String(s.n).padStart(2, "0")}
              </span>
            </div>
          ))}
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-2 border-b border-border/50 px-5 py-3">
          <div className="flex flex-1 items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5">
            <Search className="size-3.5 text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">
              Search files, parties, addresses…
            </span>
            <kbd className="ml-auto rounded border border-border bg-muted px-1 font-mono text-[9px] text-muted-foreground">
              ⌘K
            </kbd>
          </div>
          <span className="hidden font-numerals text-[10px] tabular-nums text-muted-foreground md:inline">
            35 files · 28 active
          </span>
        </div>

        {/* Header row */}
        <div className="grid grid-cols-[3rem_1fr_8rem_5rem_5.5rem] items-center gap-4 bg-[#fdf6e8]/50 px-5 py-2 text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
          <span className="text-right">№</span>
          <span>File · type</span>
          <span>Opened</span>
          <span>County</span>
          <span className="text-right">Status</span>
        </div>

        {/* Rows */}
        <ol className="divide-y divide-border/50">
          {visibleRows.map((f, i) => {
            const isFlashing = i === flashIndex;
            return (
              <li
                key={f.n}
                className={`grid grid-cols-[3rem_1fr_8rem_5rem_5.5rem] items-center gap-4 px-5 py-2.5 transition-colors ${isFlashing ? "bg-[#fdf6e8]/55" : "bg-card"}`}
              >
                <span className="font-numerals text-right text-[10px] text-muted-foreground/70 tabular-nums">
                  {String(i + 1).padStart(3, "0")}
                </span>
                <div className="min-w-0">
                  <div className="font-numerals truncate text-[12px] font-medium tracking-tight text-[#2e2430]">
                    {f.n}
                  </div>
                  <div className="text-[10px] text-muted-foreground capitalize">
                    {f.type}
                  </div>
                </div>
                <div className="font-numerals text-[10px] text-muted-foreground tabular-nums">
                  {f.open}
                </div>
                <div className="font-numerals text-[10px] text-muted-foreground">
                  {f.cnty}
                </div>
                <div className="flex justify-end">
                  <StatusPillMini
                    key={isFlashing ? `flash-${tick}` : f.n}
                    status={f.s}
                    cycling={isFlashing}
                    small
                  />
                </div>
              </li>
            );
          })}
        </ol>

        {/* Live banner */}
        <div className="flex items-center gap-2 border-t border-border/50 bg-[#fdf6e8]/40 px-5 py-2.5 text-[10px] text-muted-foreground">
          <span className="relative flex size-2 items-center justify-center">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#3f7c64]/60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-[#3f7c64]" />
          </span>
          <span className="font-numerals tracking-[0.14em] uppercase">
            Updating live · last change · 8s ago
          </span>
        </div>
      </article>
    </div>
  );
}

// ─── Section II: Reconcile ─────────────────────────────────────────────────

type Finding = {
  id: string;
  type: string;
  message: string;
  doc: string;
  severity: "block" | "warn" | "ok";
  resolved: boolean;
};

function LiveReconcile() {
  const initial: ReadonlyArray<Finding> = [
    { id: "f1", type: "name_mismatch", message: "Buyer name differs · PA vs commitment", doc: "PA · Commitment", severity: "block", resolved: false },
    { id: "f2", type: "price_mismatch", message: "Purchase price · $635,000 vs $635,500", doc: "PA · Estimate", severity: "block", resolved: false },
    { id: "f3", type: "missing_signature", message: "Counter offer · seller signature absent", doc: "Counter", severity: "warn", resolved: false },
    { id: "f4", type: "name_match", message: "Seller · matched across 3 documents", doc: "PA · Deed · Comm.", severity: "ok", resolved: true },
    { id: "f5", type: "apn_match", message: "APN · matched across deed and commitment", doc: "Deed · Comm.", severity: "ok", resolved: true },
  ];
  const [findings, setFindings] = useState<ReadonlyArray<Finding>>(initial);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 4000);
    return () => clearInterval(id);
  }, []);

  // On each tick, resolve the next unresolved finding. After all are resolved,
  // restart from scratch — the demo loops.
  useEffect(() => {
    if (tick === 0) return;
    setFindings((prev) => {
      const firstUnresolved = prev.findIndex((f) => !f.resolved);
      if (firstUnresolved === -1) {
        // restart the sequence
        return initial;
      }
      return prev.map((f, i) =>
        i === firstUnresolved ? { ...f, resolved: true, severity: "ok" as const } : f,
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const counts = useMemo(() => {
    let block = 0;
    let warn = 0;
    let ok = 0;
    for (const f of findings) {
      if (f.severity === "block" && !f.resolved) block += 1;
      else if (f.severity === "warn" && !f.resolved) warn += 1;
      else ok += 1;
    }
    return { block, warn, ok };
  }, [findings]);

  return (
    <div className="flex flex-col gap-4">
      {/* Document compare panel — full width so PA and Commitment columns
          have room to breathe. */}
      <article className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-md ring-1 ring-foreground/5">
        <header className="flex items-center justify-between gap-3 border-b border-border/60 bg-[#fdf6e8]/50 px-5 py-3">
          <div className="flex items-center gap-2">
            <Layers className="size-3.5 text-[#b78625]" />
            <span className="font-numerals text-[10px] font-semibold tracking-[0.18em] text-[#b78625] uppercase">
              Cross-doc compare
            </span>
          </div>
          <span className="font-numerals text-[10px] text-muted-foreground tabular-nums">
            3 documents · 4 fields
          </span>
        </header>
        <div className="grid grid-cols-1 divide-y divide-border/60 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <DocColumn
            kind="PA"
            title="Purchase Agreement"
            fields={[
              { k: "Buyer", v: "Maria T. Hayes" },
              { k: "Seller", v: "K. Patel Trust" },
              { k: "Price", v: "$635,000" },
              { k: "APN", v: "49-12-1208-001" },
            ]}
          />
          <DocColumn
            kind="Comm"
            title="Title Commitment"
            fields={[
              { k: "Buyer", v: "Maria Hayes", flag: true },
              { k: "Seller", v: "K. Patel Trust" },
              { k: "Price", v: "$635,500", flag: true },
              { k: "APN", v: "49-12-1208-001" },
            ]}
          />
        </div>
      </article>

      {/* Findings panel */}
      <article className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-md ring-1 ring-foreground/5">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
          <div className="flex items-center gap-2">
            <CircleAlert className="size-3.5 text-[#b78625]" />
            <span className="font-numerals text-[10px] font-semibold tracking-[0.18em] text-[#b78625] uppercase">
              Findings
            </span>
            <span className="font-numerals text-[10px] text-muted-foreground tabular-nums">
              · {findings.length} on file
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px]">
            <SevPill tone="red">{counts.block} blockers</SevPill>
            <SevPill tone="amber">{counts.warn} warn</SevPill>
            <SevPill tone="green">{counts.ok} clear</SevPill>
          </div>
        </header>
        <ol className="divide-y divide-border/50">
          {findings.map((f) => (
            <FindingRow key={f.id} f={f} />
          ))}
        </ol>
      </article>
    </div>
  );
}

function DocColumn({
  kind,
  title,
  fields,
}: {
  kind: string;
  title: string;
  fields: ReadonlyArray<{ k: string; v: string; flag?: boolean }>;
}) {
  return (
    <div className="flex flex-col gap-3 p-5">
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-lg border border-[#40233f]/15 bg-[#fdf6e8] text-[#40233f]">
          <FileText className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="font-numerals text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
            {kind}
          </div>
          <div className="font-display truncate text-base font-semibold leading-tight text-[#40233f]">
            {title}
          </div>
        </div>
      </div>
      <dl className="mt-1 grid grid-cols-[5rem_1fr] gap-x-4 gap-y-1.5">
        {fields.map((f) => (
          <Fragment key={f.k}>
            <dt className="self-baseline text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
              {f.k}
            </dt>
            <dd
              className={`self-baseline rounded-md px-1.5 py-1 font-numerals text-[12px] tabular-nums ${f.flag ? "bg-[#fdecee]/70 font-semibold text-[#8a3942]" : "text-[#2e2430]"}`}
            >
              {f.v}
              {f.flag && (
                <span className="ml-2 font-numerals text-[9px] font-semibold tracking-[0.16em] text-[#b94f58] uppercase">
                  mismatch
                </span>
              )}
            </dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

function FindingRow({ f }: { f: Finding }) {
  const justResolved = f.resolved && f.severity === "ok";
  const tone =
    !f.resolved && f.severity === "block"
      ? "bg-[#fdecee]/40"
      : !f.resolved && f.severity === "warn"
        ? "bg-[#fde9dc]/40"
        : "bg-card";
  return (
    <li className={`flex items-start gap-3 px-4 py-2.5 ${tone}`}>
      <span
        className={`tk-stamp-press mt-0.5 grid size-6 shrink-0 place-items-center rounded-full ring-1 ring-inset ${
          justResolved
            ? "bg-[#e6f3ed] text-[#2f5d4b] ring-[#3f7c64]/40"
            : f.severity === "block"
              ? "bg-[#fdecee] text-[#8a3942] ring-[#b94f58]/40"
              : f.severity === "warn"
                ? "bg-[#fde9dc] text-[#7a3d18] ring-[#c9652e]/40"
                : "bg-[#e6f3ed] text-[#2f5d4b] ring-[#3f7c64]/40"
        }`}
        key={`icon-${f.id}-${f.resolved}`}
      >
        {justResolved ? (
          <CheckCircle2 className="size-3.5" />
        ) : f.severity === "block" || f.severity === "warn" ? (
          <CircleAlert className="size-3.5" />
        ) : (
          <CheckCircle2 className="size-3.5" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] leading-snug text-[#2e2430]">
          {f.message}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="font-numerals tracking-[0.04em]">
            {f.type.replace(/_/g, " ")}
          </span>
          <span>·</span>
          <span>{f.doc}</span>
        </div>
      </div>
      {justResolved && (
        <span className="font-numerals text-[9px] font-semibold tracking-[0.14em] text-[#2f5d4b] uppercase">
          resolved
        </span>
      )}
    </li>
  );
}

function SevPill({
  tone,
  children,
}: {
  tone: "red" | "amber" | "green";
  children: React.ReactNode;
}) {
  const cls =
    tone === "red"
      ? "bg-[#fdecee] text-[#8a3942]"
      : tone === "amber"
        ? "bg-[#fde9dc] text-[#7a3d18]"
        : "bg-[#e6f3ed] text-[#2f5d4b]";
  return (
    <span
      className={`font-numerals inline-flex items-center rounded-full px-2 py-0.5 font-medium tabular-nums ${cls}`}
    >
      {children}
    </span>
  );
}

// ─── Section III: Closing day ──────────────────────────────────────────────

type ChecklistRow = {
  id: string;
  label: string;
  detail: string;
  kind: "derived" | "attestation";
};

function LiveClosing() {
  const items: ReadonlyArray<ChecklistRow> = [
    { id: "title_clear", label: "Title clear", detail: "All findings resolved", kind: "derived" },
    { id: "cpl_issued", label: "CPL issued", detail: "Closing protection letter on file", kind: "attestation" },
    { id: "wire_verified", label: "Wire phone verified", detail: "Verbally · 11:14 AM", kind: "attestation" },
    { id: "ids_verified", label: "IDs verified", detail: "Buyer & seller checked", kind: "attestation" },
    { id: "funds_confirmed", label: "Funds confirmed", detail: "Lender wire posted", kind: "attestation" },
    { id: "survey_reviewed", label: "Survey reviewed", detail: "No encroachments", kind: "attestation" },
  ];
  const [done, setDone] = useState<number>(2);

  useEffect(() => {
    const id = setInterval(() => {
      setDone((n) => (n >= items.length ? 2 : n + 1));
    }, 2400);
    return () => clearInterval(id);
  }, [items.length]);

  const progress = Math.round((done / items.length) * 100);

  return (
    <div className="relative">
      <article className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-md ring-1 ring-foreground/5">
        <header className="flex items-center justify-between gap-4 border-b border-border/60 bg-[#fdf6e8]/50 px-5 py-4">
          <div className="flex items-center gap-3">
            <CalendarClock className="size-4 text-[#b78625]" />
            <div>
              <div className="font-numerals text-[10px] font-semibold tracking-[0.18em] text-[#b78625] uppercase">
                Closing today
              </div>
              <div className="font-display text-lg leading-tight font-semibold text-[#40233f]">
                QT-2026-0036 · 1208 N Delaware
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="font-display text-2xl leading-none font-semibold tabular-nums text-[#40233f]">
              {done}/{items.length}
            </div>
            <div className="text-[10px] text-muted-foreground">
              ready in {items.length - done}
            </div>
          </div>
        </header>

        {/* Progress bar */}
        <div className="px-5 pt-4">
          <div className="h-1.5 overflow-hidden rounded-full bg-border/70">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#b78625] to-[#40233f] transition-[width] duration-[800ms] ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {/* Checklist */}
        <ol className="flex flex-col gap-1.5 px-5 py-5">
          {items.map((it, i) => {
            const isDone = i < done;
            return (
              <li
                key={it.id}
                className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 transition ${
                  isDone
                    ? "border-[#3f7c64]/30 bg-[#e6f3ed]/35"
                    : "border-border/60 bg-card"
                }`}
              >
                <span
                  key={`${it.id}-${isDone}`}
                  className={`tk-stamp-press mt-0.5 grid size-7 shrink-0 place-items-center rounded-full ring-2 ring-card ${
                    isDone
                      ? "bg-[#3f7c64] text-white"
                      : "bg-card text-muted-foreground ring-1 ring-border ring-inset"
                  }`}
                >
                  {isDone ? (
                    <Check className="size-3.5" />
                  ) : (
                    <span className="font-numerals text-[10px] font-semibold tabular-nums">
                      {i + 1}
                    </span>
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span
                      className={`font-display text-sm font-semibold tracking-tight ${isDone ? "text-[#2f5d4b]" : "text-[#40233f]"}`}
                    >
                      {it.label}
                    </span>
                    <span
                      className={`font-numerals rounded-full px-1.5 py-px text-[8px] tracking-[0.14em] uppercase ${it.kind === "derived" ? "bg-[#e8f0f8] text-[#2c4a6b]" : "bg-[#f2e7f1] text-[#40233f]"}`}
                    >
                      {it.kind}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {it.detail}
                  </div>
                </div>
                {isDone && (
                  <span className="font-numerals text-[9px] font-semibold tracking-[0.14em] text-[#2f5d4b] uppercase">
                    Attested
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </article>
    </div>
  );
}

// ─── Section IV: Mail · queue · orders ─────────────────────────────────────

function QueueAndMailFeature() {
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
      <QueueCard />
      <MailroomCard />
    </div>
  );
}

function QueueCard() {
  const items: ReadonlyArray<{
    icon: React.ReactNode;
    label: string;
    note: string;
    chip: { tone: "red" | "amber" | "violet"; text: string };
  }> = [
    {
      icon: <AlarmClock className="size-3.5" />,
      label: "Survey follow-up · QT-0039",
      note: "Overdue · 2 days",
      chip: { tone: "red", text: "overdue" },
    },
    {
      icon: <CircleAlert className="size-3.5" />,
      label: "Buyer name mismatch · QT-0042",
      note: "Assigned to you",
      chip: { tone: "amber", text: "blocker" },
    },
    {
      icon: <Mail className="size-3.5" />,
      label: "Lender package · re QT-0040",
      note: "Triage · received 1h ago",
      chip: { tone: "violet", text: "triage" },
    },
    {
      icon: <Bell className="size-3.5" />,
      label: "Closing reminder · QT-0036",
      note: "In 3 days",
      chip: { tone: "violet", text: "due" },
    },
  ];

  return (
    <article className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-md ring-1 ring-foreground/5">
      <header className="flex items-center justify-between border-b border-border/60 bg-[#fdf6e8]/50 px-5 py-4">
        <div className="flex items-center gap-3">
          <Inbox className="size-4 text-[#b78625]" />
          <div>
            <div className="font-numerals text-[10px] font-semibold tracking-[0.18em] text-[#b78625] uppercase">
              Your queue
            </div>
            <div className="font-display text-base leading-tight font-semibold text-[#40233f]">
              4 things need you
            </div>
          </div>
        </div>
        <span className="font-numerals text-[10px] text-muted-foreground tabular-nums">
          ranked by file
        </span>
      </header>
      <ol className="divide-y divide-border/50">
        {items.map((it, i) => (
          <li
            key={i}
            className="flex items-start gap-3 px-5 py-3 transition hover:bg-[#fdf6e8]/40"
          >
            <span
              className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-md ring-1 ring-inset ${
                it.chip.tone === "red"
                  ? "bg-[#fdecee] text-[#8a3942] ring-[#b94f58]/30"
                  : it.chip.tone === "amber"
                    ? "bg-[#fde9dc] text-[#7a3d18] ring-[#c9652e]/30"
                    : "bg-[#f2e7f1] text-[#40233f] ring-[#593157]/30"
              }`}
            >
              {it.icon}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium text-[#2e2430]">
                {it.label}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {it.note}
              </div>
            </div>
            <span
              className={`font-numerals rounded-full px-1.5 py-px text-[9px] font-medium tracking-[0.12em] uppercase ${
                it.chip.tone === "red"
                  ? "bg-[#fdecee] text-[#8a3942]"
                  : it.chip.tone === "amber"
                    ? "bg-[#fde9dc] text-[#7a3d18]"
                    : "bg-[#f2e7f1] text-[#40233f]"
              }`}
            >
              {it.chip.text}
            </span>
          </li>
        ))}
      </ol>
    </article>
  );
}

function MailroomCard() {
  type Email = {
    from: string;
    subject: string;
    label: "lender" | "buyer" | "spam" | "title";
    classified: boolean;
  };
  const initial: ReadonlyArray<Email> = [
    { from: "wells.fargo@noreply.com", subject: "Loan estimate · re QT-0040", label: "lender", classified: true },
    { from: "m.hayes@reliance.com", subject: "Re: signing schedule", label: "buyer", classified: true },
    { from: "marketing@xyzhome.com", subject: "Boost your closings 10×", label: "spam", classified: true },
    { from: "underwriter@amts.com", subject: "Commitment ready · QT-0042", label: "title", classified: false },
  ];
  const [list, setList] = useState<ReadonlyArray<Email>>(initial);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 3000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (tick === 0) return;
    setList((prev) => {
      const idx = prev.findIndex((e) => !e.classified);
      if (idx === -1) {
        return prev.map((e, i) => (i === 0 ? { ...e, classified: false } : e));
      }
      return prev.map((e, i) =>
        i === idx ? { ...e, classified: true } : e,
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  return (
    <article className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-md ring-1 ring-foreground/5">
      <header className="flex items-center justify-between border-b border-border/60 bg-[#fdf6e8]/50 px-5 py-4">
        <div className="flex items-center gap-3">
          <Mail className="size-4 text-[#b78625]" />
          <div>
            <div className="font-numerals text-[10px] font-semibold tracking-[0.18em] text-[#b78625] uppercase">
              The mailroom
            </div>
            <div className="font-display text-base leading-tight font-semibold text-[#40233f]">
              Auto-classifying inbound
            </div>
          </div>
        </div>
        <span className="font-numerals text-[10px] text-muted-foreground tabular-nums">
          live
        </span>
      </header>
      <ol className="divide-y divide-border/50">
        {list.map((e, i) => (
          <li key={i} className="flex items-start gap-3 px-5 py-3">
            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground ring-1 ring-inset ring-border">
              <Mail className="size-3" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-numerals truncate text-[11px] text-muted-foreground">
                {e.from}
              </div>
              <div className="truncate text-[12px] font-medium text-[#2e2430]">
                {e.subject}
              </div>
            </div>
            {e.classified ? (
              <ClassifyChip
                key={`chip-${i}-${e.label}`}
                label={e.label}
                animate
              />
            ) : (
              <span className="font-numerals inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                <Loader2 className="tk-soft-pulse size-3" />
                classifying
              </span>
            )}
          </li>
        ))}
      </ol>
    </article>
  );
}

function ClassifyChip({
  label,
  animate,
}: {
  label: "lender" | "buyer" | "spam" | "title";
  animate?: boolean;
}) {
  const tone =
    label === "spam"
      ? "bg-muted text-muted-foreground"
      : label === "lender"
        ? "bg-[#e8f0f8] text-[#2c4a6b]"
        : label === "buyer"
          ? "bg-[#e3f1f0] text-[#26595a]"
          : "bg-[#f2e7f1] text-[#40233f]";
  return (
    <span
      className={`font-numerals inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium tracking-[0.14em] uppercase ${tone} ${animate ? "tk-pill-fade" : ""}`}
    >
      {label}
    </span>
  );
}

// ─── Section V: Recording rules ────────────────────────────────────────────

function RulesFeature() {
  const versions: ReadonlyArray<{
    v: string;
    date: string;
    note: string;
    active?: boolean;
  }> = [
    { v: "v3.1", date: "May 03, 2026", note: "+ doc-stamp rate update", active: true },
    { v: "v3.0", date: "Apr 12, 2026", note: "+ exhibit B notarial reqs" },
    { v: "v2.4", date: "Feb 28, 2026", note: "fee schedule revision" },
    { v: "v2.3", date: "Jan 02, 2026", note: "deed-of-trust margins" },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_1.05fr]">
      {/* The codex card */}
      <article className="relative overflow-hidden rounded-2xl border border-border/60 bg-card shadow-md ring-1 ring-foreground/5">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 ledger-rules opacity-50"
        />
        <header className="relative flex items-center gap-3 border-b border-border/60 bg-[#fdf6e8]/60 px-5 py-4">
          <ScrollText className="size-4 text-[#b78625]" />
          <div>
            <div className="font-numerals text-[10px] font-semibold tracking-[0.18em] text-[#b78625] uppercase">
              Marion County
            </div>
            <div className="font-display text-base leading-tight font-semibold text-[#40233f]">
              Recording rules · Deed
            </div>
          </div>
          <span className="ml-auto font-numerals text-[10px] text-muted-foreground tabular-nums">
            33 counties on file
          </span>
        </header>
        <dl className="relative grid grid-cols-2 gap-px bg-border/40">
          {[
            { k: "Top margin", v: "3.0 in", note: "first page" },
            { k: "Side margins", v: "0.5 in" },
            { k: "Recording fee", v: "$25.00", note: "+ $5 per page" },
            { k: "Doc stamp", v: "$0.85/k" },
            { k: "Notarial", v: "Required" },
            { k: "Page size", v: "8.5 × 11 in" },
          ].map((r) => (
            <div key={r.k} className="flex flex-col gap-0.5 bg-card px-4 py-2.5">
              <dt className="text-[10px] tracking-[0.04em] text-muted-foreground uppercase">
                {r.k}
              </dt>
              <dd className="font-display text-sm font-semibold text-[#40233f]">
                {r.v}
              </dd>
              {r.note && (
                <span className="text-[10px] text-muted-foreground">
                  {r.note}
                </span>
              )}
            </div>
          ))}
        </dl>
      </article>

      {/* Version history */}
      <article className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-md ring-1 ring-foreground/5">
        <header className="flex items-center gap-3 border-b border-border/60 bg-[#fdf6e8]/50 px-5 py-4">
          <GitBranch className="size-4 text-[#b78625]" />
          <div>
            <div className="font-numerals text-[10px] font-semibold tracking-[0.18em] text-[#b78625] uppercase">
              Version history
            </div>
            <div className="font-display text-base leading-tight font-semibold text-[#40233f]">
              Per-file rule binding
            </div>
          </div>
        </header>
        <ol className="relative divide-y divide-border/50">
          {versions.map((v) => (
            <li key={v.v} className="flex items-start gap-3 px-5 py-3">
              <span
                className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[9px] font-semibold ${
                  v.active
                    ? "bg-[#3f7c64] text-white"
                    : "bg-card text-muted-foreground ring-1 ring-border ring-inset"
                }`}
              >
                {v.active ? <Check className="size-3" /> : v.v.slice(1, 2)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-display text-sm font-semibold text-[#40233f]">
                    {v.v}
                  </span>
                  <span className="font-numerals text-[10px] text-muted-foreground tabular-nums">
                    {v.date}
                  </span>
                  {v.active && (
                    <span className="font-numerals rounded-full bg-[#e6f3ed] px-1.5 py-px text-[9px] font-medium tracking-[0.14em] text-[#2f5d4b] uppercase">
                      in force
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {v.note}
                </div>
              </div>
            </li>
          ))}
        </ol>
        <footer className="border-t border-border/50 bg-[#fdf6e8]/40 px-5 py-3 text-[10px] text-muted-foreground">
          Files in flight resolve to the rule in force when they opened — never
          retroactively.
        </footer>
      </article>
    </div>
  );
}

// ─── Section VI: Built right ───────────────────────────────────────────────

function TrustGrid() {
  const tiles: ReadonlyArray<{
    icon: React.ReactNode;
    title: string;
    body: string;
    detail: string;
  }> = [
    {
      icon: <Network className="size-4" />,
      title: "Multi-tenant by construction",
      body: "Every read and write carries a tenant id. The data model itself enforces the wall — no cross-talk between agencies, ever.",
      detail: "Verified by an isolation test on every CI run.",
    },
    {
      icon: <Lock className="size-4" />,
      title: "NPI tokens, role-gated reveal",
      body: "SSNs, EINs, account numbers stored as tokens. Reveal is logged with purpose; clearance is a per-member toggle.",
      detail: "GLBA-aligned · audited per access.",
    },
    {
      icon: <Stamp className="size-4" />,
      title: "Audit trail per file",
      body: "Every change recorded, in order, tenant-scoped. The file's history is the file's history — append-only, attributable, exportable.",
      detail: "From extraction to attestation.",
    },
    {
      icon: <Plug className="size-4" />,
      title: "Order systems in",
      body: "SoftPro 360 today. Qualia, ResWare, Encompass on the wire. Or stand up a mock to exercise the pipeline end-to-end.",
      detail: "Webhook-first, idempotent.",
    },
    {
      icon: <Eye className="size-4" />,
      title: "Notifications grouped by file",
      body: "Blockers stand out alone. Warnings collect. Routine activity rolls up into threads — so the bell never cries wolf.",
      detail: "Severity-weighted badging.",
    },
    {
      icon: <Search className="size-4" />,
      title: "Global search",
      body: "Files, parties, findings, documents, mail — one box, ranked. Open with ⌘K from anywhere in the app.",
      detail: "Tenant-scoped index.",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {tiles.map((t, i) => (
        <article
          key={i}
          className="group/tile relative overflow-hidden rounded-2xl border border-border/60 bg-card p-5 shadow-sm ring-1 ring-foreground/5 transition hover:-translate-y-0.5 hover:shadow-md"
        >
          <div
            aria-hidden
            className="absolute -top-12 -right-12 size-32 rounded-full bg-[radial-gradient(circle,rgba(244,212,143,0.18),transparent_60%)] opacity-0 transition-opacity duration-500 group-hover/tile:opacity-100"
          />
          <div className="relative flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-xl border border-[#40233f]/15 bg-[#fdf6e8] text-[#40233f]">
              {t.icon}
            </span>
            <span className="h-px flex-1 bg-border/60" />
            <ShieldCheck className="size-3 text-[#b78625]/60" />
          </div>
          <h3 className="relative mt-4 font-display text-lg font-semibold tracking-tight text-[#40233f]">
            {t.title}
          </h3>
          <p className="relative mt-2 text-[13px] leading-[1.55] text-muted-foreground">
            {t.body}
          </p>
          <p className="relative mt-3 font-numerals text-[10px] tracking-[0.14em] text-[#b78625] uppercase">
            {t.detail}
          </p>
        </article>
      ))}
    </div>
  );
}

// ─── Section VII: Workflow ─────────────────────────────────────────────────

const ROMAN: ReadonlyArray<string> = ["I", "II", "III", "IV", "V", "VI"];

function WorkflowSteps() {
  const steps: ReadonlyArray<{ t: string; d: string }> = [
    { t: "Open the file", d: "File number, county, transaction type." },
    { t: "Add the property", d: "Address, APN, target close date." },
    { t: "Add the parties", d: "Buyer, seller, lender, signers." },
    { t: "Upload + extract", d: "PA, counter offers, commitment." },
    { t: "Reconcile", d: "Resolve every blocker before drafting." },
    { t: "Close it out", d: "Funded, recorded, policy issued." },
  ];
  return (
    <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {steps.map((s, i) => (
        <li
          key={i}
          className="group/step flex items-start gap-4 rounded-2xl border border-border/60 bg-card px-5 py-4 shadow-sm ring-1 ring-foreground/5 transition hover:border-[#40233f]/30 hover:bg-[#fdf6e8]/40"
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[#40233f] text-[#f4d48f] shadow-inner">
            <span className="font-display text-sm font-semibold tracking-wide italic">
              {ROMAN[i]}
            </span>
          </span>
          <div className="min-w-0">
            <div className="font-display text-lg leading-tight font-semibold tracking-tight text-[#40233f]">
              {s.t}
            </div>
            <div className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
              {s.d}
            </div>
          </div>
          <ArrowRight className="ml-auto size-3.5 self-center text-muted-foreground/30 transition group-hover/step:translate-x-0.5 group-hover/step:text-[#40233f]" />
        </li>
      ))}
    </ol>
  );
}

// ─── CTA: Press the seal ───────────────────────────────────────────────────

function SealCTA() {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 paper-grain opacity-50"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-[#fdf6e8]/40 to-transparent"
      />
      <div className="relative mx-auto grid w-full max-w-[1280px] grid-cols-1 items-center gap-12 px-6 py-24 lg:grid-cols-[1fr_auto] lg:py-28">
        <div className="max-w-2xl">
          <span className="font-numerals text-[10px] font-semibold tracking-[0.32em] text-[#b78625] uppercase">
            By appointment of every party
          </span>
          <h2 className="mt-4 font-display text-[2.5rem] leading-[1.02] font-semibold tracking-tight text-[#40233f] md:text-[3.5rem]">
            Press the seal.{" "}
            <span className="italic text-[#593157]">Open the register.</span>
          </h2>
          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-foreground/75">
            Title Hub is in pilot with a small set of agencies. We're adding
            firms a few at a time so we can sit beside the work and keep the
            rough edges to a minimum. If your shop sees the appeal, write us —
            we'll send you in.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button
              asChild
              size="lg"
              className="tk-letterpress gap-2 shadow-lg shadow-[#40233f]/15"
            >
              <Link to="/signin" search={{ mode: "sign-up" }}>
                Request an invitation
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="gap-2">
              <Link to="/signin">Sign in</Link>
            </Button>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="size-3.5 text-[#3f7c64]" />
              No public sign-up · invite-only
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="size-3.5 text-[#3f7c64]" />
              SOC 2 in flight
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="size-3.5 text-[#3f7c64]" />
              Hosted in the United States
            </span>
          </div>
        </div>

        <Link
          to="/signin"
          search={{ mode: "sign-up" }}
          className="tk-letterpress group/seal relative grid place-items-center"
          aria-label="Press the seal — request access"
        >
          <div className="relative isolate" style={{ width: 220, height: 220 }}>
            {/* The whole seal — rings, curved legend, ornaments, ticks —
                spins as a unit, like an embossed dial finding the page. */}
            <svg
              viewBox="0 0 100 100"
              className="tk-seal-rotor absolute inset-0"
              aria-hidden
            >
              <defs>
                {/* Both arcs are drawn left → right so text reads upright.
                    Top arc uses sweep-flag=1 (passes through the top of the
                    circle); bottom arc uses sweep-flag=0 (passes through the
                    bottom). Baseline radius 44.5 sits between the inner ring
                    at 41 and outer ring at 48. */}
                <path
                  id="seal-arc-top"
                  d="M 5.5 50 A 44.5 44.5 0 0 1 94.5 50"
                  fill="none"
                />
                <path
                  id="seal-arc-bottom"
                  d="M 5.5 50 A 44.5 44.5 0 0 0 94.5 50"
                  fill="none"
                />
              </defs>
              <circle
                cx="50"
                cy="50"
                r="48"
                fill="none"
                stroke="#40233f"
                strokeOpacity="0.24"
                strokeWidth="0.6"
              />
              <circle
                cx="50"
                cy="50"
                r="41"
                fill="none"
                stroke="#40233f"
                strokeOpacity="0.18"
                strokeWidth="0.5"
              />
              <text
                fontFamily="Fraunces, serif"
                fontSize="3"
                fontWeight="600"
                fill="#40233f"
                opacity="0.82"
                letterSpacing="0.6"
                textAnchor="middle"
              >
                <textPath href="#seal-arc-top" startOffset="50%">
                  BY · APPOINTMENT · OF · EVERY · PARTY
                </textPath>
              </text>
              <text
                fontFamily="Fraunces, serif"
                fontSize="3"
                fontWeight="600"
                fill="#40233f"
                opacity="0.82"
                letterSpacing="0.6"
                textAnchor="middle"
              >
                <textPath href="#seal-arc-bottom" startOffset="50%">
                  · TITLE · HUB · MMXXVI ·
                </textPath>
              </text>
              {/* Star ornaments at 9 and 3 o'clock mark where the two arcs
                  of text meet. */}
              <text
                x="3.4"
                y="51.5"
                fontFamily="Fraunces, serif"
                fontSize="3.6"
                fontWeight="600"
                fill="#40233f"
                opacity="0.55"
                textAnchor="middle"
              >
                ✦
              </text>
              <text
                x="96.6"
                y="51.5"
                fontFamily="Fraunces, serif"
                fontSize="3.6"
                fontWeight="600"
                fill="#40233f"
                opacity="0.55"
                textAnchor="middle"
              >
                ✦
              </text>
              {/* Inner tick rim — radial marks between the disc and the
                  inner ring, like the edge of a notarial dial. */}
              {Array.from({ length: 60 }, (_, i) => {
                const major = i % 5 === 0;
                return (
                  <line
                    key={i}
                    x1="50"
                    y1={major ? 33.5 : 35.5}
                    x2="50"
                    y2={major ? 40 : 39}
                    stroke="#40233f"
                    strokeWidth={major ? 0.8 : 0.55}
                    strokeOpacity={major ? 0.65 : 0.32}
                    strokeLinecap="round"
                    transform={`rotate(${i * 6} 50 50)`}
                  />
                );
              })}
            </svg>
            <div
              className="tk-seal-disc absolute rounded-full"
              style={{
                inset: "20%",
                background:
                  "radial-gradient(circle at 30% 26%, #f7e0a8 0%, #d6a447 38%, #b78625 64%, #8c6210 100%)",
                boxShadow:
                  "inset 0 0 0 1px rgba(64,35,63,0.34), inset 0 1px 0 rgba(255,250,235,0.55), 0 1px 1px rgba(64,35,63,0.18), 0 10px 28px -10px rgba(64,35,63,0.45)",
              }}
            >
              <span
                aria-hidden
                className="tk-seal-sheen absolute inset-0 rounded-full"
                style={{
                  background:
                    "conic-gradient(from 220deg, transparent 0deg, rgba(255,253,247,0.7) 28deg, transparent 78deg, transparent 360deg)",
                  mixBlendMode: "soft-light",
                }}
              />
              <span
                aria-hidden
                className="absolute rounded-full"
                style={{
                  inset: "12%",
                  boxShadow:
                    "inset 0 0 0 1px rgba(64,35,63,0.42), inset 0 0 8px rgba(64,35,63,0.18)",
                }}
              />
              <span
                aria-hidden
                className="font-display absolute inset-0 grid place-items-center text-[42px] leading-none font-semibold text-[#40233f]"
                style={{ textShadow: "0 1px 0 rgba(255,253,247,0.6)" }}
              >
                ❦
              </span>
            </div>
          </div>
          <span className="mt-5 font-numerals text-[10px] font-semibold tracking-[0.32em] text-[#40233f]/70 uppercase transition group-hover/seal:text-[#40233f]">
            Press to request access
          </span>
        </Link>
      </div>
    </section>
  );
}

// ─── Footer ────────────────────────────────────────────────────────────────

function MarketingFooter() {
  return (
    <footer className="relative border-t border-border/60 bg-[#fdf6e8]/40">
      <div className="mx-auto w-full max-w-[1280px] px-6 py-10">
        {/* Masthead row */}
        <div className="flex flex-wrap items-end justify-between gap-6 border-b border-[#40233f]/15 pb-6">
          <div className="flex items-center gap-4">
            <BrandMark size="md" />
            <div>
              <div className="font-display text-xl font-semibold tracking-tight text-[#40233f]">
                Title Hub
              </div>
              <div className="font-numerals text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
                A file-of-record for the title trade
              </div>
            </div>
          </div>
          <div className="font-numerals flex flex-col items-end gap-0.5 text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
            <span>Vol. I · No. 1</span>
            <span>Spring · MMXXVI</span>
          </div>
        </div>

        {/* Link grid */}
        <div className="grid grid-cols-2 gap-8 py-8 sm:grid-cols-4">
          <FooterCol heading="The product">
            <a href="#register">The register</a>
            <a href="#reconcile">Reconcile</a>
            <a href="#closing">Closing day</a>
            <a href="#mail">Mail · queue</a>
          </FooterCol>
          <FooterCol heading="Built right">
            <a href="#rules">Recording rules</a>
            <a href="#features">Multi-tenant</a>
            <a href="#features">NPI · audit</a>
            <a href="#workflow">The workflow</a>
          </FooterCol>
          <FooterCol heading="Access">
            <Link to="/signin">Sign in</Link>
            <Link to="/signin" search={{ mode: "sign-up" }}>
              Request invitation
            </Link>
            <a href="mailto:hello@titlehub.example">hello@titlehub.example</a>
          </FooterCol>
          <FooterCol heading="Made in">
            <span className="text-[#40233f]/80">Indiana</span>
            <span className="text-muted-foreground">For the trade.</span>
          </FooterCol>
        </div>

        {/* Closing strip */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#40233f]/15 pt-5 text-[11px] text-muted-foreground">
          <span>© {new Date().getFullYear()} Title Hub. Pilot environment.</span>
          <span className="font-numerals tracking-[0.14em] uppercase">
            ❦ Stet · all things in order ❦
          </span>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="font-numerals text-[10px] font-semibold tracking-[0.18em] text-[#b78625] uppercase">
        {heading}
      </div>
      <div className="flex flex-col gap-1.5 text-[13px] [&_a:hover]:text-[#40233f] [&_a]:text-muted-foreground [&_a]:transition">
        {children}
      </div>
    </div>
  );
}

export function BrandMark({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const px = size === "sm" ? 36 : size === "lg" ? 64 : 44;
  return (
    <div
      className="relative grid shrink-0 place-items-center rounded-full ring-1 ring-[#40233f]/20"
      style={{ width: px, height: px }}
    >
      <div className="absolute inset-0 rounded-full brass-foil opacity-90" />
      <div className="absolute inset-[3px] rounded-full bg-card" />
      <svg
        viewBox="0 0 32 32"
        className="relative text-[#40233f]"
        style={{ width: px * 0.62, height: px * 0.62 }}
        aria-hidden
      >
        <circle
          cx="16"
          cy="16"
          r="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="0.6"
        />
        <text
          x="16"
          y="16"
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="Fraunces, serif"
          fontSize="11"
          fontWeight="600"
          fill="currentColor"
        >
          T·H
        </text>
      </svg>
    </div>
  );
}

type Membership = {
  tenantId: string;
  legalName: string;
  slug: string;
  role: string;
  betterAuthOrgId: string;
};

function NoActiveTenantPanel({
  onActivated,
}: {
  onActivated: () => Promise<void>;
}) {
  const memberships = useQuery(convexQuery(api.tenants.listMine, {}));
  const isAdminQ = useQuery(convexQuery(api.tenants.amISystemAdmin, {}));
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [slug, setSlug] = useState("");
  const [legalName, setLegalName] = useState("");
  const [autoActivating, setAutoActivating] = useState(false);
  const [autoActivateTried, setAutoActivateTried] = useState(false);

  const list = (memberships.data?.memberships ??
    []) as ReadonlyArray<Membership>;
  const loading = memberships.isLoading;
  const isSystemAdmin = isAdminQ.data === true;

  const onPick = async (betterAuthOrgId: string) => {
    setPendingId(betterAuthOrgId);
    setError(null);
    try {
      const res = await authClient.organization.setActive({
        organizationId: betterAuthOrgId,
      });
      if (res.error) {
        throw new Error(res.error.message ?? "Failed to switch organization");
      }
      await onActivated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingId(null);
    }
  };

  // Auto-activate when the user has exactly one organization. This avoids
  // showing the picker UI at all for the common case — the dashboard just
  // appears once the session updates.
  useEffect(() => {
    if (autoActivateTried) return;
    if (loading) return;
    if (list.length !== 1) return;
    setAutoActivateTried(true);
    setAutoActivating(true);
    (async () => {
      try {
        const res = await authClient.organization.setActive({
          organizationId: list[0]!.betterAuthOrgId,
        });
        if (res.error) {
          throw new Error(
            res.error.message ?? "Failed to activate organization",
          );
        }
        await onActivated();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setAutoActivating(false);
      }
    })();
  }, [autoActivateTried, list, loading, onActivated]);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await authClient.organization.create({
        name: legalName.trim(),
        slug: slug.trim().replace(/-+$/, ""),
      });
      if (res.error) throw new Error(res.error.message ?? "Failed to create");
      // Better Auth sets the new org active automatically.
      await onActivated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  // While we're auto-activating a single org (or the first paint hasn't
  // resolved yet), show a quiet loader instead of the full picker. This
  // eliminates the "dashboard flash → picker" jump for the common case.
  if (loading || autoActivating || (list.length === 1 && !error)) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 pb-12">
        <div className="rounded-2xl border border-border/60 bg-card px-5 py-8 shadow-sm ring-1 ring-foreground/5">
          <Loading
            block
            label={
              list.length === 1
                ? `Opening ${list[0]!.legalName}`
                : "Loading your organizations"
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pb-12 h-full">
      <div className="flex flex-col gap-3">
        <div className="text-xs font-semibold text-[#b78625]">
          One step left
        </div>
        <h1 className="font-display text-4xl leading-[1.05] font-semibold tracking-tight text-[#40233f] md:text-5xl">
          Pick the organization you'll be working in.
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          You're signed in, but there's no active organization on this session.
          Pick one from your list below — or create a new one to get started.
        </p>
      </div>

      {list.length > 0 ? (
        <article className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/5">
          <header className="flex items-center justify-between border-b border-border/70 px-6 pt-5 pb-4">
            <div>
              <div className="text-xs font-semibold text-[#b78625]">
                Your organizations
              </div>
              <h2 className="font-display text-xl font-semibold tracking-tight text-[#40233f]">
                Choose one to continue
              </h2>
            </div>
            <span className="text-xs text-muted-foreground">
              {list.length} on file
            </span>
          </header>
          <ul className="divide-y divide-border/50">
            {list.map((m) => (
              <li key={m.tenantId}>
                <button
                  type="button"
                  onClick={() => onPick(m.betterAuthOrgId)}
                  disabled={pendingId !== null}
                  className="group/row flex w-full items-center gap-4 px-6 py-4 text-left transition hover:bg-[#fdf6e8]/50 disabled:opacity-60"
                >
                  <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-[#40233f]/15 bg-[#fdf6e8] text-[#40233f]">
                    <Building2 className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-medium text-[#2e2430] group-hover/row:text-[#40233f]">
                      {m.legalName}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <span className="font-numerals">{m.slug}</span> · {m.role}
                    </div>
                  </div>
                  {pendingId === m.betterAuthOrgId ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  ) : (
                    <ArrowRight className="size-4 text-muted-foreground transition group-hover/row:translate-x-0.5 group-hover/row:text-[#40233f]" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </article>
      ) : isSystemAdmin ? (
        <div className="rounded-2xl border border-dashed border-border bg-card/60 px-6 py-8 text-center shadow-sm ring-1 ring-foreground/5">
          <Building2 className="mx-auto size-6 text-muted-foreground" />
          <h3 className="mt-3 font-display text-xl font-semibold tracking-tight text-[#40233f]">
            No organizations yet
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Create your first one below — you'll become its owner.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-border/60 bg-card px-6 py-8 text-center shadow-sm ring-1 ring-foreground/5">
          <Lock className="mx-auto size-6 text-[#b78625]" />
          <h3 className="mt-3 font-display text-xl font-semibold tracking-tight text-[#40233f]">
            Awaiting an invitation
          </h3>
          <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
            Your account is set up, but you haven't been invited to an
            organization yet. Ask your administrator to send you an invitation —
            you'll be able to sign in here once they do.
          </p>
        </div>
      )}

      {error && (
        <p className="rounded-md border border-[#b94f58]/30 bg-[#fdecee] px-3 py-2 text-sm text-[#8a3942]">
          {error}
        </p>
      )}

      {isSystemAdmin && (
        <article className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/5">
          <header className="flex items-center justify-between border-b border-border/70 px-6 pt-5 pb-4">
            <div className="flex items-start gap-3">
              <div className="grid size-8 shrink-0 place-items-center rounded-md border border-[#40233f]/15 bg-[#fdf6e8] text-[#40233f]">
                <Plus className="size-4" />
              </div>
              <div>
                <div className="text-xs font-semibold text-[#b78625]">
                  {list.length === 0 ? "Get started" : "Or"}
                </div>
                <h2 className="font-display text-xl font-semibold tracking-tight text-[#40233f]">
                  Create a new organization
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  You'll be the owner. NPI access is enabled by default.
                </p>
              </div>
            </div>
            {list.length > 0 && !showCreate && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCreate(true)}
              >
                Create one
              </Button>
            )}
          </header>
          {(showCreate || list.length === 0) && (
            <form
              onSubmit={onCreate}
              className="grid grid-cols-1 gap-4 px-6 py-5 md:grid-cols-2"
            >
              <CreateField
                id="ten-legal-name"
                label="Legal name"
                hint="Quality Title Insurance LLC"
                required
              >
                <Input
                  id="ten-legal-name"
                  value={legalName}
                  onChange={(e) => setLegalName(e.target.value)}
                  placeholder="Quality Title Insurance LLC"
                  required
                  minLength={2}
                />
              </CreateField>
              <CreateField
                id="ten-slug"
                label="Slug"
                hint="URL-safe handle, lowercase, hyphens only"
                required
              >
                <Input
                  id="ten-slug"
                  value={slug}
                  onChange={(e) => setSlug(toKebabCase(e.target.value))}
                  placeholder="quality-title"
                  required
                  minLength={2}
                  maxLength={40}
                  className="font-numerals"
                />
              </CreateField>
              <div className="flex flex-wrap items-center justify-between gap-3 md:col-span-2">
                <div className="text-xs text-muted-foreground">
                  <span className="text-[#b94f58]">*</span> required.{" "}
                  {!legalName.trim() && "Add a legal name. "}
                  {!slug.trim() && "Pick a slug."}
                </div>
                <div className="flex gap-2">
                  {list.length > 0 && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowCreate(false)}
                    >
                      Cancel
                    </Button>
                  )}
                  <Button
                    type="submit"
                    disabled={creating || !legalName.trim() || !slug.trim()}
                    className="gap-1.5"
                  >
                    {creating ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        Creating...
                      </>
                    ) : (
                      <>
                        <Plus className="size-4" />
                        Create organization
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </form>
          )}
        </article>
      )}
    </div>
  );
}

function CreateField({
  id,
  label,
  hint,
  required,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-medium text-[#40233f]">
        {label}
        {required && (
          <span className="ml-1 text-[#b94f58]" aria-hidden>
            *
          </span>
        )}
      </Label>
      {children}
      {hint && (
        <span className="text-xs leading-snug text-muted-foreground">
          {hint}
        </span>
      )}
    </div>
  );
}

type TenantInfo = {
  tenantId: string;
  legalName: string;
  slug: string;
  role: string;
  canViewNpi: boolean;
};

function WelcomeOnboarding({ tenant }: { tenant: TenantInfo }) {
  const counties = useQuery(convexQuery(api.seed.listIndianaCounties, {}));
  const members = useQuery(convexQuery(api.tenants.listMembers, {}));
  const meQ = useQuery(convexQuery(api.auth.getCurrentUser, {}));

  const me = meQ.data as { name?: string | null; email?: string | null } | null;
  const firstName = (() => {
    const n = (me?.name ?? "").trim();
    if (n) return n.split(/\s+/)[0]!;
    const local = (me?.email ?? "").split("@")[0] ?? "";
    if (!local) return null;
    return local.charAt(0).toUpperCase() + local.slice(1);
  })();

  const isAdmin = tenant.role === "owner" || tenant.role === "admin";
  const countyCount = counties.data?.length ?? 0;
  const memberCount = members.data?.length ?? 0;

  const steps: ReadonlyArray<Step> = [
    {
      id: "tenant",
      title: "Firm created",
      description: tenant.legalName,
      done: true,
    },
    {
      id: "counties",
      title: "Add your counties",
      description:
        countyCount > 0
          ? `${countyCount} ${countyCount === 1 ? "county" : "counties"} on file.`
          : "Seed Indiana counties so files can map to recording rules.",
      done: countyCount > 0,
      action: isAdmin
        ? { kind: "link", to: "/admin/rules", label: "Open recording rules" }
        : null,
      lockedReason: !isAdmin ? "Your administrator handles this." : undefined,
    },
    {
      id: "team",
      title: "Invite your team",
      description:
        memberCount > 1
          ? `${memberCount} on staff.`
          : "Bring teammates in so they can work files.",
      done: memberCount > 1,
      action: isAdmin
        ? { kind: "link", to: "/admin", label: "Send invitations" }
        : null,
      lockedReason: !isAdmin ? "Your administrator handles this." : undefined,
    },
    {
      id: "first-file",
      title: "Open your first file",
      description:
        "A file is one transaction — opened, examined, closed, recorded, policied.",
      done: false,
      action: {
        kind: "link",
        to: "/files",
        search: { new: true } as const,
        label: "New file",
        primary: true,
      },
    },
  ];

  const total = steps.length;
  const completed = steps.filter((s) => s.done).length;
  const progress = Math.round((completed / total) * 100);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-12">
      <Hero
        greeting={firstName ? `Welcome, ${firstName}.` : "Welcome."}
        tenant={tenant}
        completed={completed}
        total={total}
        progress={progress}
      />

      <ol className="flex flex-col gap-3">
        {steps.map((s, i) => (
          <ChecklistRow key={s.id} index={i + 1} step={s} />
        ))}
      </ol>

      <SkipRow />

      <ResourcesStrip />
    </div>
  );
}

type Step = {
  id: string;
  title: string;
  description: string;
  done: boolean;
  action?: {
    kind: "link";
    to: string;
    search?: Record<string, unknown>;
    label: string;
    primary?: boolean;
  } | null;
  lockedReason?: string;
};

function Hero({
  greeting,
  tenant,
  completed,
  total,
  progress,
}: {
  greeting: string;
  tenant: TenantInfo;
  completed: number;
  total: number;
  progress: number;
}) {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm ring-1 ring-foreground/5">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 paper-grain opacity-50"
      />
      <div className="relative flex flex-col gap-6 px-7 py-8 md:px-10 md:py-10">
        <div className="flex flex-col gap-3">
          <div className="text-xs font-semibold text-[#b78625]">
            Welcome to Title Hub
          </div>
          <h1 className="font-display text-4xl leading-[1.05] font-semibold tracking-tight text-[#40233f] md:text-5xl">
            {greeting}
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
            Let's get{" "}
            <strong className="font-medium text-[#40233f]">
              {tenant.legalName}
            </strong>{" "}
            up and running. The four steps below cover the basics — most take a
            minute or less. Skip whatever you don't need yet.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
            <span>
              <span className="font-numerals text-[#40233f] tabular-nums">
                {completed}
              </span>{" "}
              of {total} done
            </span>
            <span className="font-numerals tabular-nums">{progress}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-border/70">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#b78625] to-[#40233f] transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function ChecklistRow({ index, step }: { index: number; step: Step }) {
  const { done, action, lockedReason } = step;
  return (
    <li
      className={`group/row flex items-start gap-4 rounded-2xl border bg-card px-5 py-4 shadow-sm ring-1 ring-foreground/5 transition ${
        done
          ? "border-[#3f7c64]/30"
          : "border-border/60 hover:border-[#40233f]/40 hover:shadow-md"
      }`}
    >
      <div
        className={`mt-0.5 grid size-9 shrink-0 place-items-center rounded-full ring-2 ring-card ${
          done
            ? "bg-[#3f7c64] text-white"
            : "bg-card text-muted-foreground ring-1 ring-border ring-inset"
        }`}
      >
        {done ? (
          <Check className="size-4" />
        ) : (
          <span className="font-numerals text-sm font-semibold tabular-nums">
            {index}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3
            className={`font-display text-lg font-semibold tracking-tight ${
              done ? "text-[#2f5d4b]" : "text-[#40233f]"
            }`}
          >
            {step.title}
          </h3>
          {done && (
            <span className="text-xs font-medium text-[#2f5d4b]">Done</span>
          )}
          {!done && lockedReason && (
            <span className="text-xs text-muted-foreground">
              · {lockedReason}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
          {step.description}
        </p>
      </div>

      {!done && action && action.kind === "link" && (
        <Button
          asChild
          size="sm"
          variant={action.primary ? "default" : "outline"}
          className="shrink-0 gap-1.5"
        >
          {action.search ? (
            <Link to={action.to} search={action.search as never}>
              {action.label}
              <ArrowRight className="size-3.5" />
            </Link>
          ) : (
            <Link to={action.to}>
              {action.label}
              <ArrowRight className="size-3.5" />
            </Link>
          )}
        </Button>
      )}
    </li>
  );
}

function SkipRow() {
  return (
    <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
      <span>You can come back to these later.</span>
      <Link
        to="/files"
        className="font-medium text-[#40233f] underline underline-offset-2 hover:text-[#593157]"
      >
        Skip the tour
      </Link>
    </div>
  );
}

function ResourcesStrip() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <ResourceCard
        icon={<FileText className="size-4" />}
        title="The register"
        body="Every file in one place, grouped by stage."
        to="/files"
      />
      <ResourceCard
        icon={<Layers className="size-4" />}
        title="Reconciliation"
        body="Cross-document checks before drafting closing docs."
        to="/files"
      />
      <ResourceCard
        icon={<ScrollText className="size-4" />}
        title="Recording rules"
        body="Margins, fees, exhibits — versioned per county."
        to="/admin/rules"
      />
    </div>
  );
}

function ResourceCard({
  icon,
  title,
  body,
  to,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  to: string;
}) {
  return (
    <Link
      to={to}
      className="group/card flex items-start gap-3 rounded-xl border border-border/60 bg-card/80 p-4 ring-1 ring-foreground/5 transition hover:bg-card hover:shadow-md"
    >
      <div className="grid size-8 shrink-0 place-items-center rounded-md border border-[#40233f]/15 bg-[#fdf6e8] text-[#40233f]">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="font-medium text-[#40233f]">{title}</div>
        <div className="text-xs text-muted-foreground">{body}</div>
      </div>
      <ArrowRight className="ml-auto size-3.5 shrink-0 self-center text-muted-foreground/40 transition group-hover/card:translate-x-0.5 group-hover/card:text-[#40233f]" />
    </Link>
  );
}

function Dashboard() {
  const current = useQuery(convexQuery(api.tenants.current, {}));
  // Wait for the active-tenant gate before subscribing to files, so we don't
  // fire `files.list` during the brief NO_ACTIVE_TENANT window on first login.
  const files = useQuery({
    ...convexQuery(api.files.list, {}),
    enabled: !!current.data,
  });

  // Until the active-tenant check resolves we don't know whether to render the
  // dashboard or the org picker. Render the dashboard skeleton (the common
  // case after first paint) so the user sees structure immediately instead of
  // a centered spinner.
  if (current.isPending) {
    return (
      <AppShell isAuthenticated title="Dashboard">
        <DashboardSkeleton />
      </AppShell>
    );
  }

  // tenants.current returns null for the transient not-signed-in / no-active-
  // tenant / not-a-member states. Show the org picker; auto-activate kicks in
  // for users with exactly one membership.
  if (current.data === null) {
    return (
      <AppShell isAuthenticated noHeader title="Welcome">
        <NoActiveTenantPanel
          onActivated={async () => {
            await current.refetch();
          }}
        />
      </AppShell>
    );
  }

  if (current.error) {
    return (
      <AppShell isAuthenticated title="Dashboard">
        <div className="text-sm text-destructive">
          Error: {current.error.message}
        </div>
      </AppShell>
    );
  }

  const subtitle = current.data
    ? `${current.data.legalName} · ${current.data.role}`
    : "Loading...";

  // Hold the dashboard until `files` has actually resolved. Without this, the
  // onboarding panel flashes during the first paint because `files.data` is
  // undefined → length 0 → "new tenant" is briefly true even when the user
  // has files. Render the dashboard skeleton so layout is stable while we
  // wait for the files subscription.
  if (files.isPending) {
    return (
      <AppShell isAuthenticated title="Dashboard" subtitle={subtitle}>
        <DashboardSkeleton />
      </AppShell>
    );
  }

  // New users (active tenant, no files yet) see an onboarding checklist
  // instead of the empty register. Once they open their first file, or
  // explicitly skip, the regular dashboard takes over.
  const isNewTenant = !!current.data && (files.data?.length ?? 0) === 0;

  return (
    <AppShell
      isAuthenticated
      title={isNewTenant ? "Welcome" : "Dashboard"}
      subtitle={subtitle}
    >
      {isNewTenant ? (
        <WelcomeOnboarding tenant={current.data!} />
      ) : (
        <DashboardContent files={files.data ?? []} />
      )}
    </AppShell>
  );
}

type FileRow = {
  _id: string;
  fileNumber: string;
  transactionType: string;
  stateCode: string;
  status: string;
  openedAt: number;
  targetCloseDate?: number;
};

function DashboardContent({ files }: { files: ReadonlyArray<FileRow> }) {
  // Single pass over files instead of four .filter()/.sort() chains. With
  // a Convex live subscription, files updates land on every server-side
  // change — re-deriving these on each render would be wasted work.
  const { open, closingSoon, cancelled, inExam } = useMemo<{
    open: ReadonlyArray<FileRow>;
    closingSoon: ReadonlyArray<FileRow>;
    cancelled: number;
    inExam: number;
  }>(() => {
    const cutoff = Date.now() + 7 * 24 * 3600 * 1000;
    const openList: FileRow[] = [];
    let cancelledCount = 0;
    let inExamCount = 0;
    for (const f of files) {
      if (f.status === "cancelled") {
        cancelledCount += 1;
        continue;
      }
      if (f.status === "policied") continue;
      openList.push(f);
      if (f.status === "in_exam") inExamCount += 1;
    }
    const closing = openList
      .filter((f) => f.targetCloseDate && f.targetCloseDate < cutoff)
      .sort((a, b) => (a.targetCloseDate ?? 0) - (b.targetCloseDate ?? 0))
      .slice(0, 5);
    return {
      open: openList,
      closingSoon: closing,
      cancelled: cancelledCount,
      inExam: inExamCount,
    };
  }, [files]);

  return (
    <div className="flex flex-col gap-6 pb-12">
      <DashboardHeader totalFiles={files.length} />

      <KpiStrip
        active={open.length}
        inExam={inExam}
        closingSoon={closingSoon.length}
        cancelled={cancelled}
        totalFiles={files.length}
      />

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <article className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/5 lg:col-span-8">
          <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border/70 px-6 pt-5 pb-4">
            <div>
              <h2 className="font-display text-xl leading-none font-semibold tracking-tight text-[#40233f]">
                Open files
              </h2>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Most recently opened, listed first. Click any entry for the
                full docket.
              </p>
            </div>
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link to="/files">
                View all
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </header>

          {open.length === 0 ? (
            <div className="px-6 py-14 text-center text-sm text-muted-foreground">
              No active files. The register stands empty for now.
            </div>
          ) : (
            <ol className="divide-y divide-border/60">
              <li className="hidden grid-cols-[3rem_1fr_8rem_5rem_5.5rem] items-center gap-4 bg-[#fdf6e8]/50 px-6 py-2 text-xs text-muted-foreground sm:grid">
                <span className="text-right">№</span>
                <span>File · type</span>
                <span>Opened</span>
                <span>Cnty</span>
                <span className="text-right">Status</span>
              </li>
              {open.slice(0, 7).map((f, i) => (
                <li key={f._id}>
                  <Link
                    to="/files/$fileId"
                    params={{ fileId: f._id }}
                    className="group/row grid grid-cols-[3rem_1fr_8rem_5rem_5.5rem] items-center gap-4 px-6 py-3 transition hover:bg-[#fdf6e8]/40"
                  >
                    <span className="font-numerals text-right text-xs text-muted-foreground/70 tabular-nums">
                      {String(i + 1).padStart(3, "0")}
                    </span>
                    <div className="min-w-0">
                      <div className="font-numerals truncate text-sm font-medium tracking-tight text-[#2e2430] group-hover/row:text-[#40233f]">
                        {f.fileNumber}
                      </div>
                      <div className="text-xs text-muted-foreground capitalize">
                        {f.transactionType}
                      </div>
                    </div>
                    <div className="font-numerals text-xs text-muted-foreground tabular-nums">
                      {new Date(f.openedAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "2-digit",
                        year: "2-digit",
                      })}
                    </div>
                    <div className="font-numerals text-xs text-muted-foreground">
                      {f.stateCode}
                    </div>
                    <div className="flex justify-end">
                      <StatusStamp status={f.status} />
                    </div>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </article>

        <aside className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/5 lg:col-span-4">
          <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border/70 px-6 pt-5 pb-4">
            <div>
              <h2 className="font-display text-xl leading-none font-semibold tracking-tight text-[#40233f]">
                Closing this week
              </h2>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Files targeted to close within seven days.
              </p>
            </div>
          </header>

          <div className="px-4 py-3">
            {closingSoon.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                Nothing on the calendar.
              </div>
            ) : (
              <ul className="flex flex-col">
                {closingSoon.map((f) => (
                  <li
                    key={f._id}
                    className="group/closing flex items-center gap-3 border-b border-border/50 py-3 last:border-b-0"
                  >
                    <DayStub timestamp={f.targetCloseDate!} />
                    <div className="min-w-0 flex-1">
                      <Link
                        to="/files/$fileId"
                        params={{ fileId: f._id }}
                        className="font-numerals block truncate text-sm font-medium text-[#2e2430] transition hover:text-[#40233f]"
                      >
                        {f.fileNumber}
                      </Link>
                      <div className="text-xs text-muted-foreground capitalize">
                        {f.transactionType} · {f.stateCode}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </section>

      <LiveActivityFeed />
    </div>
  );
}

type DashActor =
  | {
      kind: "member";
      memberId: string;
      email: string;
      name: string | null;
      role: string;
    }
  | { kind: "system" }
  | { kind: "unknown"; type: string };

type DashEvent = {
  _id: string;
  action: string;
  occurredAt: number;
  resourceType: string;
  resourceId: string;
  metadata?: unknown;
  actor?: DashActor;
  file?: {
    fileId: string;
    fileNumber: string;
    propertyAddressLine1: string | null;
    city: string | null;
    state: string | null;
  } | null;
};

const DASH_VERBS: Record<string, string> = {
  "file.created": "opened a file",
  "file.status_changed": "changed a file's status",
  "file.party_added": "added a party",
  "file.party_removed": "removed a party",
  "file.updated": "updated a file",
  "document.uploaded": "uploaded a document",
  "document.deleted": "deleted a document",
  "documents.deduped": "removed duplicate docs",
  "extraction.requested": "started an extraction",
  "extraction.succeeded": "finished an extraction",
  "extraction.failed": "extraction failed",
  "reconciliation.run": "ran reconciliation",
  "reconciliation.finding_resolved": "resolved a finding",
  "reconciliation.finding_acknowledged": "acknowledged a finding",
  "reconciliation.finding_dismissed": "dismissed a finding",
  "secret.issued": "issued a tokenized secret",
  "secret.revealed": "revealed a tokenized secret",
};

function describeDashAction(action: string): string {
  return (
    DASH_VERBS[action] ??
    action
      .split(".")
      .pop()!
      .replace(/_/g, " ")
      .replace(/^./, (c) => c.toLowerCase())
  );
}

function dashActionDetail(e: DashEvent): string | null {
  const md = (e.metadata ?? {}) as Record<string, unknown>;
  switch (e.action) {
    case "file.status_changed":
      if (md.from && md.to) return `${md.from} → ${md.to}`;
      return null;
    case "file.party_added":
    case "file.party_removed":
      if (typeof md.legalName === "string") return String(md.legalName);
      return null;
    case "document.uploaded":
    case "document.deleted":
    case "extraction.requested":
      if (typeof md.docType === "string") return md.docType.replace(/_/g, " ");
      return null;
    case "reconciliation.run":
      if (md.bySeverity && typeof md.bySeverity === "object") {
        const s = md.bySeverity as Record<string, number>;
        const total = (s.block ?? 0) + (s.warn ?? 0) + (s.info ?? 0);
        if (total === 0) return "all clear";
        const parts: string[] = [];
        if (s.block)
          parts.push(`${s.block} blocker${s.block === 1 ? "" : "s"}`);
        if (s.warn) parts.push(`${s.warn} warning${s.warn === 1 ? "" : "s"}`);
        if (s.info) parts.push(`${s.info} info`);
        return parts.join(" · ");
      }
      return null;
    default:
      return null;
  }
}

function LiveActivityFeed() {
  const events = useQuery({
    ...convexQuery(api.audit.listForTenant, { limit: 10 }),
    retry: false,
  });
  const list = (events.data ?? []) as ReadonlyArray<DashEvent>;

  return (
    <article className="overflow-hidden rounded-2xl bg-card shadow-md ring-1 ring-foreground/5">
      <header className="flex items-center justify-between border-b border-border/70 px-7 pt-6 pb-4">
        <div className="flex items-center gap-3">
          <span className="relative flex size-2.5 items-center justify-center">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#3f7c64] opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-[#3f7c64]" />
          </span>
          <div>
            <div className="text-xs font-semibold text-[#b78625]">
              Section · live
            </div>
            <h2 className="font-display text-2xl leading-none font-semibold tracking-tight text-[#40233f]">
              Recently
            </h2>
          </div>
        </div>
        <Link
          to="/history"
          className="text-xs font-medium text-[#593157] underline-offset-4 hover:underline"
        >
          View all →
        </Link>
      </header>

      {events.isLoading ? (
        <div className="px-7 py-8">
          <Loading size="sm" label="Gathering activity" />
        </div>
      ) : list.length === 0 ? (
        <div className="px-7 py-10 text-center text-sm text-muted-foreground">
          Nothing's happened yet. Open a file to get the loop going.
        </div>
      ) : (
        <ol className="divide-y divide-border/50">
          {list.map((e) => (
            <ActivityFeedRow key={e._id} event={e} />
          ))}
        </ol>
      )}
    </article>
  );
}

function ActivityFeedRow({ event }: { event: DashEvent }) {
  const verb = describeDashAction(event.action);
  const detail = dashActionDetail(event);
  const actor = event.actor;
  const actorLabel =
    actor?.kind === "member"
      ? actor.name && actor.name.trim().length > 0
        ? actor.name
        : actor.email
      : actor?.kind === "system"
        ? "System"
        : "Unknown";

  // Prefer the enriched file context (works for any event tied to a file
  // via metadata.fileId, not just resourceType=file). Falls back to the
  // legacy resourceType=file path so older rows still render.
  const fileTarget = event.file
    ? { fileId: event.file.fileId, fileNumber: event.file.fileNumber }
    : event.resourceType === "file"
      ? { fileId: event.resourceId, fileNumber: null }
      : null;

  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    fileTarget ? (
      <Link
        to="/files/$fileId"
        params={{ fileId: fileTarget.fileId }}
        className="group/feed flex items-start gap-3 px-7 py-3 transition hover:bg-[#fdf6e8]/50"
      >
        {children}
      </Link>
    ) : (
      <div className="flex items-start gap-3 px-7 py-3">{children}</div>
    );

  const addressBlurb = event.file
    ? [event.file.propertyAddressLine1, event.file.city]
        .filter(Boolean)
        .join(", ")
    : null;

  return (
    <li className="tk-slide-in">
      <Wrapper>
        <FeedAvatar actor={actor} />
        <div className="min-w-0 flex-1">
          <div className="text-sm leading-snug text-[#2e2430]">
            <span className="font-medium text-[#40233f]">{actorLabel}</span>{" "}
            <span className="text-muted-foreground">{verb}</span>
            {detail && (
              <>
                {" — "}
                <span className="text-foreground/80">{detail}</span>
              </>
            )}
          </div>
          {(event.file || addressBlurb) && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs">
              {event.file?.fileNumber && (
                <span className="font-numerals font-medium text-[#40233f]">
                  {event.file.fileNumber}
                </span>
              )}
              {addressBlurb && (
                <>
                  {event.file?.fileNumber && (
                    <span className="text-muted-foreground/60">·</span>
                  )}
                  <span className="truncate text-muted-foreground">
                    {addressBlurb}
                  </span>
                </>
              )}
            </div>
          )}
          <div className="mt-0.5 text-xs text-muted-foreground">
            {timeAgo(event.occurredAt)}
          </div>
        </div>
      </Wrapper>
    </li>
  );
}

function FeedAvatar({ actor }: { actor?: DashActor }) {
  if (actor?.kind === "system") {
    return (
      <div className="grid size-7 shrink-0 place-items-center rounded-full bg-[#40233f] text-[#f4d48f] ring-4 ring-card">
        <Sparkles className="size-3" />
      </div>
    );
  }
  if (actor?.kind === "member") {
    const name = (actor.name ?? "").trim();
    const seed = name || actor.email;
    const parts = name
      ? name
          .split(/\s+/)
          .slice(0, 2)
          .map((p) => p[0])
          .join("")
      : (() => {
          const local = (actor.email.split("@")[0] ?? "").split(/[._-]+/);
          return (local[0]?.[0] ?? "") + (local[1]?.[0] ?? "");
        })();
    void seed;
    return (
      <div className="grid size-7 shrink-0 place-items-center rounded-full border border-[#40233f]/15 bg-[#fdf6e8] text-xs font-semibold text-[#40233f] ring-4 ring-card">
        {(parts || "··").toUpperCase()}
      </div>
    );
  }
  return (
    <div className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium text-muted-foreground ring-4 ring-card">
      ?
    </div>
  );
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function DashboardHeader({ totalFiles }: { totalFiles: number }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl leading-[1] font-semibold tracking-tight text-[#40233f] md:text-5xl">
            Dashboard
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            What's open right now, what's about to close, and the latest
            activity across the workspace.
          </p>
        </div>
        {totalFiles > 0 && (
          <div className="font-numerals text-xs text-muted-foreground tabular-nums">
            {totalFiles} file{totalFiles === 1 ? "" : "s"} of record
          </div>
        )}
      </div>
    </div>
  );
}

function KpiStrip({
  active,
  inExam,
  closingSoon,
  cancelled,
  totalFiles,
}: {
  active: number;
  inExam: number;
  closingSoon: number;
  cancelled: number;
  totalFiles: number;
}) {
  const tiles: ReadonlyArray<{
    label: string;
    value: number;
    caption: string;
    accent: string;
  }> = [
    {
      label: "Active files",
      value: active,
      caption: "opened, in exam, cleared, closing",
      accent: "text-[#40233f]",
    },
    {
      label: "In examination",
      value: inExam,
      caption: "awaiting reconciliation",
      accent: "text-[#2c4a6b]",
    },
    {
      label: "Closing in 7 days",
      value: closingSoon,
      caption: "targeted to close",
      accent: "text-[#7a3d18]",
    },
    {
      label: "Cancelled YTD",
      value: cancelled,
      caption: `of ${totalFiles} total opened`,
      accent: "text-[#8a3942]",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map((t) => (
        <div
          key={t.label}
          className="flex flex-col gap-1 rounded-2xl border border-border/70 bg-card px-4 py-3 shadow-sm ring-1 ring-foreground/5"
        >
          <div className={`text-xs font-medium ${t.accent}`}>{t.label}</div>
          <div className="font-display text-2xl leading-none font-semibold tabular-nums text-[#40233f]">
            {String(t.value).padStart(2, "0")}
          </div>
          <div className="text-xs text-muted-foreground">{t.caption}</div>
        </div>
      ))}
    </div>
  );
}

function StatusStamp({ status }: { status: string }) {
  const tone =
    status === "policied"
      ? {
          ring: "ring-[#3f7c64]/40",
          text: "text-[#2f5d4b]",
          bg: "bg-[#e6f3ed]",
        }
      : status === "closing"
        ? {
            ring: "ring-[#b78625]/45",
            text: "text-[#7a5818]",
            bg: "bg-[#f8eed7]",
          }
        : status === "cleared"
          ? {
              ring: "ring-[#3f668f]/40",
              text: "text-[#2c4a6b]",
              bg: "bg-[#e8f0f8]",
            }
          : status === "in_exam"
            ? {
                ring: "ring-[#593157]/35",
                text: "text-[#40233f]",
                bg: "bg-[#f2e7f1]",
              }
            : status === "cancelled"
              ? {
                  ring: "ring-[#b94f58]/45",
                  text: "text-[#8a3942]",
                  bg: "bg-[#fdecee]",
                }
              : {
                  ring: "ring-border",
                  text: "text-muted-foreground",
                  bg: "bg-muted",
                };

  const label = status.replace(/_/g, " ");

  return (
    <span
      className={`font-numerals inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ring-1 ring-inset ${tone.ring} ${tone.text} ${tone.bg}`}
    >
      <span
        className={`size-1 rounded-full ${tone.text.replace("text", "bg")}`}
      />
      {label}
    </span>
  );
}

function DayStub({ timestamp }: { timestamp: number }) {
  const d = new Date(timestamp);
  const days = Math.ceil((timestamp - Date.now()) / (24 * 3600 * 1000));
  const overdue = days < 0;
  const today = days === 0;
  return (
    <div className="relative grid w-12 shrink-0 place-items-center">
      <div
        className={`flex w-full flex-col items-center rounded-md border bg-card py-1 ${
          overdue
            ? "border-[#b94f58]/40 bg-[#fdecee]"
            : today
              ? "border-[#b78625]/40 bg-[#fdf6e8]"
              : "border-border/70"
        }`}
      >
        <div className="text-[8px] uppercase tracking-wider text-muted-foreground">
          {d.toLocaleString("en-US", { month: "short" })}
        </div>
        <div
          className={`font-display text-xl leading-none font-semibold ${
            overdue
              ? "text-[#8a3942]"
              : today
                ? "text-[#7a5818]"
                : "text-[#40233f]"
          }`}
        >
          {d.getDate()}
        </div>
      </div>
      <div className="font-numerals mt-1 text-[10px] text-muted-foreground tabular-nums">
        {overdue ? `${Math.abs(days)}d ago` : today ? "today" : `in ${days}d`}
      </div>
    </div>
  );
}

