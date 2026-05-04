import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import {
  AlertTriangle,
  CircleAlert,
  Files,
  History,
  Info,
  RotateCcw,
  ShieldOff,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppShell } from "@/components/app-shell";
import {
  PageHeaderSkeleton,
  SectionSkeleton,
} from "@/components/skeletons";
import { useConfirm } from "@/components/confirm-dialog";
import { api } from "../../../convex/_generated/api";

type Severity = "info" | "warn" | "block";
type PolicySeverity = Severity | "off";
type CatalogRow = {
  type: string;
  label: string;
  description: string;
  category: "price" | "parties" | "property" | "closing" | "wire" | "documents";
  defaultSeverity: Severity;
  overrideSeverity: PolicySeverity | null;
  updatedAt: number | null;
};

const CATEGORY_LABEL: Record<CatalogRow["category"], string> = {
  price: "Price",
  parties: "Parties & vesting",
  property: "Property of record",
  closing: "Closing terms",
  wire: "Wire instructions",
  documents: "Required documents",
};
const CATEGORY_ORDER: ReadonlyArray<CatalogRow["category"]> = [
  "price",
  "parties",
  "property",
  "closing",
  "wire",
  "documents",
];

const SEVERITY_OPTIONS: ReadonlyArray<{
  value: PolicySeverity;
  label: string;
  description: string;
  Icon: typeof Info;
  classes: string;
  activeClasses: string;
}> = [
  {
    value: "block",
    label: "Block",
    description: "Stops a file from advancing past in_exam.",
    Icon: AlertTriangle,
    classes: "text-[#8a3942]",
    activeClasses: "bg-[#fdecee] ring-[#b94f58]/40 text-[#8a3942]",
  },
  {
    value: "warn",
    label: "Warn",
    description: "Surfaces in the queue and bell, but doesn't block.",
    Icon: CircleAlert,
    classes: "text-[#7a3d18]",
    activeClasses: "bg-[#fde9dc] ring-[#c9652e]/40 text-[#7a3d18]",
  },
  {
    value: "info",
    label: "Info",
    description: "Logged for visibility only, no escalation.",
    Icon: Info,
    classes: "text-[#26456b]",
    activeClasses: "bg-[#e6eef7] ring-[#3f668f]/40 text-[#26456b]",
  },
  {
    value: "off",
    label: "Off",
    description: "Suppress entirely. The check still runs; the finding never lands.",
    Icon: ShieldOff,
    classes: "text-muted-foreground",
    activeClasses: "bg-muted ring-foreground/15 text-foreground",
  },
];

export const Route = createFileRoute("/admin/reconciliation")({
  head: () => ({
    meta: [
      { title: "Reconciliation policy · Title Hub" },
      {
        name: "description",
        content:
          "Tune which cross-document findings block closings vs. warn vs. log only — per finding type, per tenant.",
      },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!(context as { isAuthenticated?: boolean }).isAuthenticated) {
      throw redirect({ to: "/signin" });
    }
  },
  loader: ({ context }) => {
    const { queryClient } = context as { queryClient: QueryClient };
    void queryClient.ensureQueryData(convexQuery(api.tenants.current, {}));
    void queryClient.ensureQueryData(
      convexQuery(api.reconciliationPolicy.listForTenant, {}),
    );
    void queryClient.ensureQueryData(
      convexQuery(api.reconciliationPolicy.getTolerances, {}),
    );
    void queryClient.ensureQueryData(
      convexQuery(api.reconciliationPolicy.listRequiredDocs, {}),
    );
    void queryClient.ensureQueryData(
      convexQuery(api.reconciliationPolicy.recentAuditEvents, { limit: 20 }),
    );
  },
  component: ReconciliationPolicyPage,
});

function ReconciliationPolicyPage() {
  const current = useQuery(convexQuery(api.tenants.current, {}));
  const catalog = useQuery(
    convexQuery(api.reconciliationPolicy.listForTenant, {}),
  );

  if (current.isLoading || catalog.isLoading) {
    return (
      <AppShell isAuthenticated title="Reconciliation policy">
        <div className="flex flex-col gap-6 pb-12">
          <PageHeaderSkeleton />
          <SectionSkeleton rows={6} />
          <SectionSkeleton rows={5} />
        </div>
      </AppShell>
    );
  }
  if (current.error) {
    return (
      <AppShell isAuthenticated title="Reconciliation policy">
        <p className="text-sm text-destructive">{current.error.message}</p>
      </AppShell>
    );
  }
  if (current.data?.role !== "owner") {
    return (
      <AppShell isAuthenticated title="Reconciliation policy">
        <Card className="mx-auto max-w-xl">
          <CardHeader>
            <CardTitle>No access</CardTitle>
            <CardDescription>
              Reconciliation policy can only be tuned by the organization owner.
              This is the same gate that protects recording rules.
            </CardDescription>
          </CardHeader>
        </Card>
      </AppShell>
    );
  }

  const rows = (catalog.data ?? []) as ReadonlyArray<CatalogRow>;
  const overrideCount = rows.filter((r) => r.overrideSeverity !== null).length;

  return (
    <AppShell
      isAuthenticated
      title="Reconciliation policy"
      subtitle="Decide which cross-document findings block closings, warn, or log only."
    >
      <div className="flex flex-col gap-6 pb-12">
        <PolicyHeader overrideCount={overrideCount} totalCount={rows.length} />
        <TolerancesCard />
        <PolicyTable rows={rows} />
        <RequiredDocsCard />
        <AuditTimeline />
      </div>
    </AppShell>
  );
}

function PolicyHeader({
  overrideCount,
  totalCount,
}: {
  overrideCount: number;
  totalCount: number;
}) {
  const confirm = useConfirm();
  const resetAll = useConvexMutation(api.reconciliationPolicy.resetAll);
  const [pending, setPending] = useState(false);

  const onResetAll = async () => {
    if (overrideCount === 0) return;
    const ok = await confirm({
      title: "Reset all overrides?",
      description: `${overrideCount} override${
        overrideCount === 1 ? "" : "s"
      } will be removed and every finding type will fall back to its catalog default.`,
      confirmText: "Reset",
      destructive: true,
    });
    if (!ok) return;
    setPending(true);
    try {
      await resetAll({});
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-border/60 bg-card px-5 py-4 shadow-sm ring-1 ring-foreground/5">
      <div className="flex min-w-0 items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#fdf6e8] text-[#7a5818] ring-1 ring-[#b78625]/20">
          <SlidersHorizontal className="size-5" />
        </div>
        <div className="min-w-0">
          <div className="font-display text-xl font-semibold tracking-tight text-[#40233f]">
            {overrideCount === 0
              ? "Running on default policy"
              : overrideCount === 1
                ? "1 override active"
                : `${overrideCount} overrides active`}
          </div>
          <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">
            Each finding type has a built-in severity. Override below to tune
            false-positives and false-negatives without code changes. Changes
            apply to the next reconciliation run on every file.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {totalCount} finding type{totalCount === 1 ? "" : "s"}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={overrideCount === 0 || pending}
          onClick={onResetAll}
        >
          <RotateCcw className="size-3.5" />
          Reset all to defaults
        </Button>
      </div>
    </div>
  );
}

function PolicyTable({ rows }: { rows: ReadonlyArray<CatalogRow> }) {
  const grouped = useMemo(() => {
    const map = new Map<CatalogRow["category"], CatalogRow[]>();
    for (const r of rows) {
      const arr = map.get(r.category) ?? [];
      arr.push(r);
      map.set(r.category, arr);
    }
    return CATEGORY_ORDER.map((cat) => ({
      category: cat,
      label: CATEGORY_LABEL[cat],
      items: map.get(cat) ?? [],
    })).filter((g) => g.items.length > 0);
  }, [rows]);

  return (
    <div className="flex flex-col gap-6">
      {grouped.map((group) => (
        <section
          key={group.category}
          className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/5"
        >
          <header className="flex items-center justify-between gap-3 border-b border-border/60 bg-[#fdf6e8]/40 px-5 py-3">
            <div className="font-display text-sm font-semibold tracking-tight text-[#40233f]">
              {group.label}
            </div>
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {group.items.length} type{group.items.length === 1 ? "" : "s"}
            </span>
          </header>
          <ol className="divide-y divide-border/50">
            {group.items.map((row) => (
              <PolicyRow key={row.type} row={row} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function PolicyRow({ row }: { row: CatalogRow }) {
  const upsert = useConvexMutation(api.reconciliationPolicy.upsert);
  const reset = useConvexMutation(api.reconciliationPolicy.reset);
  const [pending, setPending] = useState<PolicySeverity | "reset" | null>(null);

  const effective: PolicySeverity = row.overrideSeverity ?? row.defaultSeverity;
  const isOverride = row.overrideSeverity !== null;

  const apply = async (severity: PolicySeverity) => {
    if (severity === effective && isOverride) return;
    setPending(severity);
    try {
      // If the choice equals the catalog default, prefer reset over upsert
      // so the row stays "clean" and we don't accumulate redundant rows.
      if (severity === row.defaultSeverity) {
        await reset({ findingType: row.type });
      } else {
        await upsert({ findingType: row.type, severity });
      }
    } finally {
      setPending(null);
    }
  };

  const onReset = async () => {
    setPending("reset");
    try {
      await reset({ findingType: row.type });
    } finally {
      setPending(null);
    }
  };

  return (
    <li className="grid grid-cols-1 items-start gap-3 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-6">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-[#2e2430]">{row.label}</span>
          <code className="rounded border border-border/60 bg-muted px-1.5 py-px font-mono text-[10px] tabular-nums text-muted-foreground">
            {row.type}
          </code>
          {isOverride && (
            <motion.span
              key={`badge-${row.overrideSeverity}`}
              initial={{ transform: "scale(0.85)", opacity: 0 }}
              animate={{ transform: "scale(1)", opacity: 1 }}
              transition={{ type: "spring", duration: 0.4, bounce: 0.3 }}
              className="inline-flex items-center gap-1 rounded-full bg-[#f1eaf3] px-2 py-px text-[10px] font-medium text-[#593157]"
            >
              <span className="size-1 rounded-full bg-[#593157]" />
              Custom
            </motion.span>
          )}
        </div>
        <p className="mt-1 max-w-prose text-xs text-muted-foreground">
          {row.description}
        </p>
        <div className="mt-1.5 font-mono text-[10px] tracking-wide text-muted-foreground/80">
          Default: {row.defaultSeverity}
          {isOverride && row.updatedAt && (
            <>
              {" · "}
              <span>Last changed {formatTime(row.updatedAt)}</span>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 lg:justify-end">
        <SeveritySegmented
          effective={effective}
          pending={pending === "reset" ? null : (pending as PolicySeverity | null)}
          onPick={apply}
        />
        {isOverride && (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={pending !== null}
            onClick={onReset}
            aria-label="Reset to default"
            title="Reset to default"
          >
            <RotateCcw className="size-3.5" />
          </Button>
        )}
      </div>
    </li>
  );
}

function SeveritySegmented({
  effective,
  pending,
  onPick,
}: {
  effective: PolicySeverity;
  pending: PolicySeverity | null;
  onPick: (s: PolicySeverity) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Severity"
      className="inline-flex items-center gap-1 rounded-xl border border-border bg-card p-0.5 shadow-xs"
    >
      {SEVERITY_OPTIONS.map((opt) => {
        const active = effective === opt.value;
        const isPending = pending === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={pending !== null}
            onClick={() => onPick(opt.value)}
            title={opt.description}
            className={`group/sev relative inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ring-1 ring-transparent transition-[color,background-color,box-shadow,transform] duration-[160ms] ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.97] ${
              active ? opt.activeClasses : `${opt.classes} hover:bg-muted/60`
            } ${isPending ? "opacity-70" : ""}`}
          >
            <opt.Icon className="size-3.5" />
            {opt.label}
            {active && (
              <motion.span
                layoutId="severity-active-indicator"
                className="pointer-events-none absolute inset-0 rounded-lg ring-1 ring-current/20"
                transition={{ type: "spring", duration: 0.35, bounce: 0.2 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Tolerances card — numeric thresholds owners can tune
// ─────────────────────────────────────────────────────────────────────

type TolerancesPayload = {
  effective: {
    salePriceVarianceLow: number;
    salePriceVarianceHigh: number;
    wireAmountRedFlagRatio: number;
  };
  defaults: {
    salePriceVarianceLow: number;
    salePriceVarianceHigh: number;
    wireAmountRedFlagRatio: number;
  };
  bounds: Record<
    "salePriceVarianceLow" | "salePriceVarianceHigh" | "wireAmountRedFlagRatio",
    { min: number; max: number; step: number }
  >;
  hasOverride: boolean;
  updatedAt: number | null;
};

function TolerancesCard() {
  const data = useQuery(
    convexQuery(api.reconciliationPolicy.getTolerances, {}),
  );
  const setTol = useConvexMutation(api.reconciliationPolicy.setTolerances);
  const resetTol = useConvexMutation(api.reconciliationPolicy.resetTolerances);
  const confirm = useConfirm();

  // Local form state, seeded from server. We don't use useEffect to sync —
  // a `key` on the form remounts it when the server-side identity changes.
  const eff = data.data?.effective ?? null;
  const formKey = data.data
    ? `${data.data.effective.salePriceVarianceLow}-${data.data.effective.salePriceVarianceHigh}-${data.data.effective.wireAmountRedFlagRatio}-${data.data.updatedAt ?? 0}`
    : "loading";

  if (!eff || !data.data) {
    return (
      <section className="rounded-2xl bg-card p-5 shadow-sm ring-1 ring-foreground/5">
        <SectionSkeleton rows={3} withHeader={false} />
      </section>
    );
  }

  return (
    <TolerancesForm
      key={formKey}
      data={data.data as TolerancesPayload}
      onSave={(values) => setTol(values)}
      onReset={async () => {
        if (!data.data?.hasOverride) return;
        const ok = await confirm({
          title: "Reset tolerances?",
          description:
            "Sale-price variance and wire ratio will return to catalog defaults.",
          confirmText: "Reset",
          destructive: true,
        });
        if (!ok) return;
        await resetTol({});
      }}
    />
  );
}

function TolerancesForm({
  data,
  onSave,
  onReset,
}: {
  data: TolerancesPayload;
  onSave: (v: {
    salePriceVarianceLow: number;
    salePriceVarianceHigh: number;
    wireAmountRedFlagRatio: number;
  }) => Promise<unknown>;
  onReset: () => Promise<void>;
}) {
  const [low, setLow] = useState(data.effective.salePriceVarianceLow);
  const [high, setHigh] = useState(data.effective.salePriceVarianceHigh);
  const [wire, setWire] = useState(data.effective.wireAmountRedFlagRatio);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const dirty =
    low !== data.effective.salePriceVarianceLow ||
    high !== data.effective.salePriceVarianceHigh ||
    wire !== data.effective.wireAmountRedFlagRatio;

  const lowB = data.bounds.salePriceVarianceLow;
  const highB = data.bounds.salePriceVarianceHigh;
  const wireB = data.bounds.wireAmountRedFlagRatio;
  const invalidBand = low >= high;
  const outOfRange =
    low < lowB.min ||
    low > lowB.max ||
    high < highB.min ||
    high > highB.max ||
    wire < wireB.min ||
    wire > wireB.max;
  const canSave = dirty && !invalidBand && !outOfRange && !saving;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave({
        salePriceVarianceLow: low,
        salePriceVarianceHigh: high,
        wireAmountRedFlagRatio: wire,
      });
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/5"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-[#fdf6e8]/40 px-5 py-3">
        <div>
          <div className="font-display text-sm font-semibold tracking-tight text-[#40233f]">
            Numeric tolerances
          </div>
          <div className="text-[11px] text-muted-foreground">
            Bands and thresholds the reconciler uses for sale-price variance and
            wire amount checks.
          </div>
        </div>
        {data.hasOverride && data.updatedAt && (
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            Last changed {formatTime(data.updatedAt)}
          </span>
        )}
      </header>

      <div className="grid grid-cols-1 gap-5 p-5 md:grid-cols-3">
        <NumberField
          label="Sale-price variance · lower"
          help={`Below ${formatPct(low)} of market value triggers a finding.`}
          value={low}
          onChange={setLow}
          {...lowB}
          defaultValue={data.defaults.salePriceVarianceLow}
        />
        <NumberField
          label="Sale-price variance · upper"
          help={`Above ${formatPct(high)} of market value triggers a finding.`}
          value={high}
          onChange={setHigh}
          {...highB}
          defaultValue={data.defaults.salePriceVarianceHigh}
        />
        <NumberField
          label="Wire amount red flag"
          help={`Wire ≥ ${wire.toFixed(2)}× the contract price triggers a finding.`}
          value={wire}
          onChange={setWire}
          {...wireB}
          defaultValue={data.defaults.wireAmountRedFlagRatio}
          formatValue={(v) => `${v.toFixed(2)}×`}
        />
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 px-5 py-3">
        <div className="flex min-w-0 items-center gap-2 text-[11px]">
          {invalidBand && (
            <span className="text-[#8a3942]">
              Lower must be less than upper.
            </span>
          )}
          {!invalidBand && outOfRange && (
            <span className="text-[#8a3942]">
              One or more values are out of range.
            </span>
          )}
          {!dirty && savedAt && (
            <motion.span
              key={savedAt}
              initial={{ transform: "translateY(2px)", opacity: 0 }}
              animate={{ transform: "translateY(0)", opacity: 1 }}
              transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
              className="font-medium text-[#2f5d4b]"
            >
              Saved · applies to the next reconciliation run.
            </motion.span>
          )}
          {dirty && !invalidBand && !outOfRange && (
            <span className="text-muted-foreground">Unsaved changes</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {data.hasOverride && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={onReset}
            >
              <RotateCcw className="size-3.5" />
              Reset
            </Button>
          )}
          <Button type="submit" size="sm" disabled={!canSave}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </footer>
    </form>
  );
}

function NumberField({
  label,
  help,
  value,
  onChange,
  min,
  max,
  step,
  defaultValue,
  formatValue,
}: {
  label: string;
  help: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  formatValue?: (n: number) => string;
}) {
  const display = formatValue ? formatValue(value) : value.toFixed(2);
  const isDefault = Math.abs(value - defaultValue) < 1e-9;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs font-medium text-[#40233f]">{label}</Label>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {display}
        </span>
      </div>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const next = e.target.valueAsNumber;
          if (Number.isFinite(next)) onChange(next);
        }}
        className="h-8 font-mono text-sm tabular-nums"
      />
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">{help}</span>
        {!isDefault && (
          <button
            type="button"
            onClick={() => onChange(defaultValue)}
            className="shrink-0 font-medium text-[#593157] transition hover:text-[#40233f] hover:underline"
          >
            default {formatValue ? formatValue(defaultValue) : defaultValue}
          </button>
        )}
      </div>
    </div>
  );
}

function formatPct(n: number) {
  const pct = Math.round((n - 1) * 100);
  if (pct === 0) return "the market value";
  if (pct < 0) return `${Math.abs(pct)}% below market`;
  return `${pct}% above market`;
}

// ─────────────────────────────────────────────────────────────────────
// Required documents per transaction type
// ─────────────────────────────────────────────────────────────────────

type DocCatalogItem = {
  type: string;
  label: string;
  description: string;
};

type TransactionTypeRow = {
  code: string;
  name: string;
  platformDefault: ReadonlyArray<string>;
  effective: ReadonlyArray<string>;
  isOverride: boolean;
  updatedAt: number | null;
};

type RequiredDocsPayload = {
  transactionTypes: ReadonlyArray<TransactionTypeRow>;
  catalog: ReadonlyArray<DocCatalogItem>;
};

function RequiredDocsCard() {
  const data = useQuery(
    convexQuery(api.reconciliationPolicy.listRequiredDocs, {}),
  );
  if (!data.data) {
    return (
      <section className="rounded-2xl bg-card p-5 shadow-sm ring-1 ring-foreground/5">
        <SectionSkeleton rows={4} withHeader={false} />
      </section>
    );
  }
  const payload = data.data as RequiredDocsPayload;
  const labelByType = new Map(payload.catalog.map((c) => [c.type, c.label]));
  return (
    <section className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/5">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-[#fdf6e8]/40 px-5 py-3">
        <div className="flex items-center gap-2">
          <Files className="size-4 text-[#7a5818]" />
          <div className="font-display text-sm font-semibold tracking-tight text-[#40233f]">
            Required documents per transaction type
          </div>
        </div>
        <div className="text-[11px] text-muted-foreground">
          A file missing any required doc emits{" "}
          <code className="font-mono text-[10px]">missing_required_documents</code>.
        </div>
      </header>
      <ol className="divide-y divide-border/50">
        {payload.transactionTypes.map((row) => (
          <RequiredDocsRow
            key={row.code}
            row={row}
            catalog={payload.catalog}
            labelByType={labelByType}
          />
        ))}
      </ol>
    </section>
  );
}

function RequiredDocsRow({
  row,
  catalog,
  labelByType,
}: {
  row: TransactionTypeRow;
  catalog: ReadonlyArray<DocCatalogItem>;
  labelByType: Map<string, string>;
}) {
  const setReq = useConvexMutation(api.reconciliationPolicy.setRequiredDocs);
  const resetReq = useConvexMutation(api.reconciliationPolicy.resetRequiredDocs);
  const [pending, setPending] = useState<string | null>(null);

  const effectiveSet = useMemo(
    () => new Set(row.effective),
    [row.effective],
  );
  const inactive = catalog.filter((c) => !effectiveSet.has(c.type));

  const apply = async (next: ReadonlyArray<string>) => {
    setPending("save");
    try {
      await setReq({ code: row.code, requiredDocs: [...next] });
    } finally {
      setPending(null);
    }
  };

  const remove = async (type: string) => {
    setPending(type);
    try {
      const next = row.effective.filter((d) => d !== type);
      await setReq({ code: row.code, requiredDocs: next });
    } finally {
      setPending(null);
    }
  };

  const add = async (type: string) => {
    setPending(`add:${type}`);
    try {
      await setReq({ code: row.code, requiredDocs: [...row.effective, type] });
    } finally {
      setPending(null);
    }
  };

  const onReset = async () => {
    setPending("reset");
    try {
      await resetReq({ code: row.code });
    } finally {
      setPending(null);
    }
  };

  return (
    <li className="grid grid-cols-1 gap-3 px-5 py-4 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-6">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <div className="font-medium text-[#2e2430]">{row.name}</div>
          <code className="rounded border border-border/60 bg-muted px-1.5 py-px font-mono text-[10px] tabular-nums text-muted-foreground">
            {row.code}
          </code>
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          {row.effective.length} required doc
          {row.effective.length === 1 ? "" : "s"}
        </div>
        {row.isOverride ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] tracking-wide text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded-full bg-[#f1eaf3] px-2 py-px text-[#593157]">
              <span className="size-1 rounded-full bg-[#593157]" />
              Custom
            </span>
            {row.updatedAt && <span>Last changed {formatTime(row.updatedAt)}</span>}
            <button
              type="button"
              onClick={onReset}
              disabled={pending !== null}
              className="font-medium text-[#593157] transition hover:text-[#40233f] hover:underline disabled:opacity-60"
            >
              Reset to default
            </button>
          </div>
        ) : (
          <div className="mt-1 font-mono text-[10px] tracking-wide text-muted-foreground/80">
            Using platform default
          </div>
        )}
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          {row.effective.length === 0 && (
            <span className="text-xs text-muted-foreground">
              No documents required.
            </span>
          )}
          <AnimatePresenceList>
            {row.effective.map((type) => {
              const label = labelByType.get(type) ?? type;
              const isFromDefault = row.platformDefault.includes(type);
              return (
                <DocChip
                  key={type}
                  label={label}
                  type={type}
                  removable
                  pending={pending === type}
                  fromDefault={isFromDefault}
                  onRemove={() => remove(type)}
                />
              );
            })}
          </AnimatePresenceList>
        </div>

        {inactive.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
              Add
            </span>
            {inactive.map((c) => (
              <button
                key={c.type}
                type="button"
                onClick={() => add(c.type)}
                disabled={pending !== null}
                title={c.description}
                className="group/add inline-flex items-center gap-1 rounded-full border border-dashed border-border bg-card px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-[transform,color,border-color,background-color] duration-[160ms] ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-[#b78625] hover:bg-[#fdf6e8] hover:text-[#7a5818] active:scale-[0.97] disabled:opacity-60"
              >
                <span className="text-current">+</span>
                {c.label}
              </button>
            ))}
          </div>
        )}

        {row.isOverride && row.platformDefault.length > 0 && (
          <DefaultsHint
            platform={row.platformDefault}
            effective={row.effective}
            labelByType={labelByType}
            onApply={() => apply(row.platformDefault)}
          />
        )}
      </div>
    </li>
  );
}

function DocChip({
  label,
  type,
  removable,
  pending,
  fromDefault,
  onRemove,
}: {
  label: string;
  type: string;
  removable: boolean;
  pending: boolean;
  fromDefault: boolean;
  onRemove: () => void;
}) {
  return (
    <motion.span
      layout
      initial={{ transform: "scale(0.85)", opacity: 0 }}
      animate={{ transform: "scale(1)", opacity: 1 }}
      exit={{ transform: "scale(0.85)", opacity: 0 }}
      transition={{ type: "spring", duration: 0.35, bounce: 0.25 }}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        fromDefault
          ? "bg-[#fdf6e8] text-[#7a5818]"
          : "bg-[#f1eaf3] text-[#593157]"
      } ${pending ? "opacity-60" : ""}`}
      title={`${label} · ${type}${fromDefault ? " · platform default" : " · added by tenant"}`}
    >
      {label}
      {removable && (
        <button
          type="button"
          onClick={onRemove}
          disabled={pending}
          aria-label={`Remove ${label}`}
          className="-mr-0.5 rounded-full p-0.5 text-current/70 transition hover:bg-black/5 hover:text-current active:scale-90"
        >
          <X className="size-3" />
        </button>
      )}
    </motion.span>
  );
}

/** Wrap children with AnimatePresence so chip enter/exit animates. */
function AnimatePresenceList({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AnimatePresence initial={false}>{children}</AnimatePresence>;
}

function DefaultsHint({
  platform,
  effective,
  labelByType,
  onApply,
}: {
  platform: ReadonlyArray<string>;
  effective: ReadonlyArray<string>;
  labelByType: Map<string, string>;
  onApply: () => void;
}) {
  const missing = platform.filter((d) => !effective.includes(d));
  const extra = effective.filter((d) => !platform.includes(d));
  if (missing.length === 0 && extra.length === 0) return null;
  return (
    <div className="mt-2 text-[11px] text-muted-foreground">
      <span>
        Platform default would{" "}
        {missing.length > 0 && (
          <>
            require{" "}
            <span className="font-medium text-[#7a5818]">
              {missing.map((d) => labelByType.get(d) ?? d).join(", ")}
            </span>
          </>
        )}
        {missing.length > 0 && extra.length > 0 && " and "}
        {extra.length > 0 && (
          <>
            drop{" "}
            <span className="font-medium text-[#593157]">
              {extra.map((d) => labelByType.get(d) ?? d).join(", ")}
            </span>
          </>
        )}
        .
      </span>{" "}
      <button
        type="button"
        onClick={onApply}
        className="font-medium text-[#593157] transition hover:text-[#40233f] hover:underline"
      >
        Apply default
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Audit timeline
// ─────────────────────────────────────────────────────────────────────

type AuditRow = {
  id: string;
  action: string;
  occurredAt: number;
  resourceId: string;
  actorType: string;
  actorLabel: string;
  metadata: Record<string, unknown>;
};

const AUDIT_LABEL: Record<string, string> = {
  "reconciliationPolicy.upsert": "Severity changed",
  "reconciliationPolicy.reset": "Severity reset",
  "reconciliationPolicy.resetAll": "All severities reset",
  "reconciliationPolicy.setTolerances": "Tolerances updated",
  "reconciliationPolicy.resetTolerances": "Tolerances reset",
  "reconciliationPolicy.setRequiredDocs": "Required docs changed",
  "reconciliationPolicy.resetRequiredDocs": "Required docs reset",
};

function AuditTimeline() {
  const audit = useQuery(
    convexQuery(api.reconciliationPolicy.recentAuditEvents, { limit: 20 }),
  );
  const rows = (audit.data ?? []) as ReadonlyArray<AuditRow>;

  return (
    <section className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/5">
      <header className="flex items-center justify-between gap-3 border-b border-border/60 bg-[#fdf6e8]/40 px-5 py-3">
        <div className="flex items-center gap-2">
          <History className="size-4 text-[#7a5818]" />
          <div className="font-display text-sm font-semibold tracking-tight text-[#40233f]">
            Recent changes
          </div>
        </div>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {rows.length === 0
            ? "no changes yet"
            : `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`}
        </span>
      </header>
      {rows.length === 0 ? (
        <div className="px-5 py-6 text-sm text-muted-foreground">
          Severity and tolerance changes will appear here. We keep the most
          recent twenty.
        </div>
      ) : (
        <ol className="divide-y divide-border/50">
          {rows.map((r) => (
            <AuditRowView key={r.id} row={r} />
          ))}
        </ol>
      )}
    </section>
  );
}

function AuditRowView({ row }: { row: AuditRow }) {
  const label = AUDIT_LABEL[row.action] ?? row.action;
  const detail = describeAudit(row);
  return (
    <li className="grid grid-cols-[8rem_1fr_auto] items-baseline gap-4 px-5 py-2.5">
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatTime(row.occurredAt)}
      </span>
      <div className="min-w-0">
        <div className="text-sm font-medium text-[#2e2430]">{label}</div>
        {detail && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {detail}
          </div>
        )}
      </div>
      <span className="truncate text-[11px] text-muted-foreground">
        {row.actorLabel}
      </span>
    </li>
  );
}

function describeAudit(row: AuditRow): string | null {
  const m = row.metadata;
  switch (row.action) {
    case "reconciliationPolicy.upsert": {
      const sev = m.severity;
      return `${row.resourceId} → ${typeof sev === "string" ? sev : "?"}`;
    }
    case "reconciliationPolicy.reset":
      return `${row.resourceId} → default`;
    case "reconciliationPolicy.resetAll":
      return typeof m.cleared === "number"
        ? `${m.cleared} override${m.cleared === 1 ? "" : "s"} cleared`
        : null;
    case "reconciliationPolicy.setTolerances": {
      const lo = m.salePriceVarianceLow;
      const hi = m.salePriceVarianceHigh;
      const w = m.wireAmountRedFlagRatio;
      const parts: string[] = [];
      if (typeof lo === "number" && typeof hi === "number") {
        parts.push(`band [${lo.toFixed(2)}, ${hi.toFixed(2)}]`);
      }
      if (typeof w === "number") parts.push(`wire ≥ ${w.toFixed(2)}×`);
      return parts.join(" · ") || null;
    }
    case "reconciliationPolicy.resetTolerances":
      return "back to defaults";
    case "reconciliationPolicy.setRequiredDocs": {
      const docs = m.requiredDocs;
      if (Array.isArray(docs)) {
        const list = (docs as ReadonlyArray<string>).slice(0, 4).join(", ");
        const more = docs.length > 4 ? ` +${docs.length - 4}` : "";
        return `${row.resourceId}: ${list || "none"}${more}`;
      }
      return row.resourceId;
    }
    case "reconciliationPolicy.resetRequiredDocs":
      return `${row.resourceId} → platform default`;
    default:
      return null;
  }
}

function formatTime(ts: number) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
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
