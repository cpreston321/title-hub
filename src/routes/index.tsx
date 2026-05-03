import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { convexQuery } from "@convex-dev/react-query";
import { authClient } from "@/lib/auth-client";
import {
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  FileText,
  Layers,
  Loader2,
  Lock,
  Plus,
  ScrollText,
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
    <div className="min-h-svh">
      <MarketingTopNav />
      <MarketingHero />
      <MarketingFeatures />
      <MarketingWorkflow />
      <MarketingFooter />
    </div>
  );
}

function MarketingTopNav() {
  return (
    <header className="sticky top-0 z-20 border-b border-border/60 bg-background/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1240px] items-center justify-between gap-4 px-6 py-4">
        <Link to="/" className="flex items-center gap-3">
          <BrandMark />
          <div className="leading-tight">
            <div className="font-display text-base font-semibold tracking-tight text-[#40233f]">
              Title Hub
            </div>
            <div className="text-xs text-muted-foreground">
              Operations for title agencies
            </div>
          </div>
        </Link>
        <nav className="hidden items-center gap-6 md:flex">
          <a
            href="#features"
            className="text-sm text-muted-foreground transition hover:text-[#40233f]"
          >
            Features
          </a>
          <a
            href="#workflow"
            className="text-sm text-muted-foreground transition hover:text-[#40233f]"
          >
            How it works
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to="/signin">Sign in</Link>
          </Button>
          <Button asChild size="sm" className="gap-1.5">
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

function MarketingHero() {
  return (
    <section className="relative overflow-hidden border-b border-border/60">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 paper-grain opacity-50"
      />
      <div className="relative mx-auto grid w-full max-w-[1240px] grid-cols-1 items-center gap-12 px-6 py-20 lg:grid-cols-[1.1fr_1fr] lg:py-28">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-card px-3 py-1 text-xs font-medium text-[#b78625] shadow-sm">
            <Sparkles className="size-3.5" />
            Pilot · invite only
          </div>
          <h1 className="mt-5 font-display text-5xl leading-[1.02] font-semibold tracking-tight text-[#40233f] md:text-6xl lg:text-7xl">
            Title operations, made plain.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg">
            One register for every file. Cross-document checks that catch
            mismatches before closing. Versioned recording rules per county.
            Multi-tenant by construction — no cross-talk between agencies.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button asChild size="lg" className="gap-2">
              <Link to="/signin">
                Sign in
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/signin" search={{ mode: "sign-up" }}>
                Request an invitation
              </Link>
            </Button>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
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

        <HeroPreview />
      </div>
    </section>
  );
}

function HeroPreview() {
  return (
    <div className="relative">
      <div
        aria-hidden
        className="absolute -inset-6 rounded-[2rem] bg-gradient-to-br from-[#fdf6e8] via-[#f6efe4] to-[#f2e7f1] blur-2xl"
      />
      <div className="relative overflow-hidden rounded-2xl border border-border/70 bg-card shadow-2xl ring-1 ring-foreground/10">
        <div className="flex items-center justify-between border-b border-border/60 bg-[#fdf6e8]/60 px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-[#b94f58]/60" />
            <span className="size-2 rounded-full bg-[#b78625]/60" />
            <span className="size-2 rounded-full bg-[#3f7c64]/60" />
          </div>
          <div className="font-numerals text-xs text-muted-foreground tabular-nums">
            QT-2026-0042
          </div>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div>
            <div className="text-xs font-semibold text-[#b78625]">
              Section · register
            </div>
            <h3 className="font-display text-2xl leading-tight font-semibold tracking-tight text-[#40233f]">
              1208 N Delaware St
            </h3>
            <div className="text-xs text-muted-foreground">
              Indianapolis, IN 46202 · Marion County · Purchase
            </div>
          </div>

          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border/70 ring-1 ring-foreground/5">
            <PreviewStat label="Stage" value="In exam" tone="plum" />
            <PreviewStat label="Closing" value="in 9d" tone="amber" />
            <PreviewStat label="Parties" value="04" />
            <PreviewStat
              label="Findings"
              value="✓"
              tone="good"
              sub="all clear"
            />
          </div>

          <ol className="flex flex-col gap-1.5">
            {[
              { l: "Property", d: true },
              { l: "Parties", d: true },
              { l: "Documents", d: true },
              { l: "Reconcile", d: false },
            ].map((s, i) => (
              <li
                key={s.l}
                className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2"
              >
                <span
                  className={`grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums ${
                    s.d
                      ? "bg-[#3f7c64] text-white"
                      : "bg-card text-muted-foreground ring-1 ring-border ring-inset"
                  }`}
                >
                  {s.d ? <CheckCircle2 className="size-3.5" /> : i + 1}
                </span>
                <span className="text-sm font-medium text-[#40233f]">
                  {s.l}
                </span>
                <span
                  className={`ml-auto text-xs ${
                    s.d ? "text-[#2f5d4b]" : "text-muted-foreground"
                  }`}
                >
                  {s.d ? "done" : "ready to run"}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

function PreviewStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "plum" | "amber" | "good";
}) {
  const valueClass =
    tone === "good"
      ? "text-[#2f5d4b]"
      : tone === "amber"
        ? "text-[#7a5818]"
        : "text-[#40233f]";
  return (
    <div className="bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`mt-1 font-display text-xl leading-none font-semibold tabular-nums ${valueClass}`}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function MarketingFeatures() {
  return (
    <section
      id="features"
      className="border-b border-border/60 bg-card/60 py-20"
    >
      <div className="mx-auto w-full max-w-[1240px] px-6">
        <div className="max-w-2xl">
          <div className="text-xs font-semibold text-[#b78625]">
            What you get
          </div>
          <h2 className="mt-2 font-display text-3xl font-semibold tracking-tight text-[#40233f] md:text-4xl">
            A quiet workshop for the work that matters.
          </h2>
          <p className="mt-3 text-base leading-relaxed text-muted-foreground">
            Title Hub is built around the file — opened to policy issued — with
            the parts of the workflow that actually catch mistakes.
          </p>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          <Feature
            icon={<FileText className="size-5" />}
            title="The register"
            body="Every file in one place, grouped by stage. Click a row to open the docket; click a stage to filter."
          />
          <Feature
            icon={<Layers className="size-5" />}
            title="Cross-document checks"
            body="Reconcile lines up every fact across every document. Resolve blockers before drafting closing docs."
          />
          <Feature
            icon={<ScrollText className="size-5" />}
            title="Versioned recording rules"
            body="Margins, fees, exhibits, notarial requirements — versioned per county and document type. Files in flight always resolve to the rule that was in force when they opened."
          />
          <Feature
            icon={<Lock className="size-5" />}
            title="NPI gated by role"
            body="SSNs, EINs, account numbers stored as tokens. Reveal is logged with purpose; clearance is a per-member toggle."
          />
          <Feature
            icon={<Stamp className="size-5" />}
            title="Audit trail per file"
            body="Every change recorded, in order, tenant-scoped. The file's history is the file's history."
          />
          <Feature
            icon={<Sparkles className="size-5" />}
            title="Order systems in"
            body="SoftPro 360 today — more on the way. Or stand up a mock integration to exercise the pipeline end-to-end."
          />
        </div>
      </div>
    </section>
  );
}

function Feature({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-card p-6 shadow-sm ring-1 ring-foreground/5 transition hover:shadow-md">
      <div className="grid size-10 place-items-center rounded-xl border border-[#40233f]/15 bg-[#fdf6e8] text-[#40233f]">
        {icon}
      </div>
      <h3 className="mt-4 font-display text-xl font-semibold tracking-tight text-[#40233f]">
        {title}
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {body}
      </p>
    </div>
  );
}

function MarketingWorkflow() {
  const steps = [
    { n: 1, t: "Open the file", d: "File number, county, transaction type." },
    { n: 2, t: "Add the property", d: "Address, APN, target close date." },
    { n: 3, t: "Add the parties", d: "Buyer, seller, lender, signers." },
    { n: 4, t: "Upload + extract", d: "PA, counter offers, commitment." },
    { n: 5, t: "Reconcile", d: "Resolve every blocker before drafting." },
    { n: 6, t: "Close it out", d: "Funded, recorded, policy issued." },
  ];
  return (
    <section id="workflow" className="border-b border-border/60 py-20">
      <div className="mx-auto w-full max-w-[1240px] px-6">
        <div className="max-w-2xl">
          <div className="text-xs font-semibold text-[#b78625]">
            How it works
          </div>
          <h2 className="mt-2 font-display text-3xl font-semibold tracking-tight text-[#40233f] md:text-4xl">
            Six steps, opened to policy.
          </h2>
          <p className="mt-3 text-base leading-relaxed text-muted-foreground">
            The same workflow every file follows. Each step unlocks the next —
            so reconciliation is most useful when you've got a property,
            parties, and at least two documents to compare.
          </p>
        </div>

        <ol className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {steps.map((s) => (
            <li
              key={s.n}
              className="flex items-start gap-4 rounded-xl border border-border/60 bg-card px-5 py-4 shadow-sm ring-1 ring-foreground/5"
            >
              <span className="font-numerals grid size-9 shrink-0 place-items-center rounded-full bg-[#40233f] text-base font-semibold text-[#f4d48f] tabular-nums">
                {s.n}
              </span>
              <div className="min-w-0">
                <div className="font-display text-lg leading-tight font-semibold tracking-tight text-[#40233f]">
                  {s.t}
                </div>
                <div className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                  {s.d}
                </div>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-10 flex flex-wrap items-center gap-3">
          <Button asChild size="lg" className="gap-2">
            <Link to="/signin">
              Sign in to your tenant
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          <span className="text-sm text-muted-foreground">
            or{" "}
            <Link
              to="/signin"
              search={{ mode: "sign-up" }}
              className="font-medium text-[#40233f] underline underline-offset-2 hover:text-[#593157]"
            >
              request an invitation
            </Link>
            .
          </span>
        </div>
      </div>
    </section>
  );
}

function MarketingFooter() {
  return (
    <footer className="py-10">
      <div className="mx-auto flex w-full max-w-[1240px] flex-wrap items-center justify-between gap-4 px-6">
        <div className="flex items-center gap-3">
          <BrandMark size="sm" />
          <span className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} Title Hub. Pilot environment.
          </span>
        </div>
        <div className="flex items-center gap-5 text-sm text-muted-foreground">
          <a href="#features" className="transition hover:text-[#40233f]">
            Features
          </a>
          <a href="#workflow" className="transition hover:text-[#40233f]">
            How it works
          </a>
          <Link to="/signin" className="transition hover:text-[#40233f]">
            Sign in
          </Link>
        </div>
      </div>
    </footer>
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

