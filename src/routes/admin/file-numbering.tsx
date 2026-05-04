import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { Hash, Plus, RotateCcw, Sparkles } from "lucide-react";
import { motion } from "motion/react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AppShell } from "@/components/app-shell";
import {
  PageHeaderSkeleton,
  SectionSkeleton,
} from "@/components/skeletons";
import { useConfirm } from "@/components/confirm-dialog";
import { api } from "../../../convex/_generated/api";

type Cadence = "never" | "yearly" | "monthly";

type PolicyData = {
  pattern: string;
  nextSeq: number;
  seqResetCadence: Cadence;
  seqLastResetBoundary: string;
  isCustomized: boolean;
  defaultPattern: string;
  tokens: ReadonlyArray<{
    name: string;
    label: string;
    example: string;
    parameterized: boolean;
  }>;
  updatedAt: number | null;
};

const PRESETS: ReadonlyArray<{
  label: string;
  pattern: string;
  cadence: Cadence;
  hint: string;
}> = [
  {
    label: "Year + sequence",
    pattern: "{YYYY}-{SEQ:4}",
    cadence: "yearly",
    hint: "Counter resets each January 1.",
  },
  {
    label: "Year + month + sequence",
    pattern: "{YYYY}-{MM}-{SEQ:3}",
    cadence: "monthly",
    hint: "Counter resets on the 1st of each month.",
  },
  {
    label: "Initials prefix",
    pattern: "QT-{YYYY}-{SEQ:4}",
    cadence: "yearly",
    hint: "QT prefix; year-scoped counter.",
  },
  {
    label: "County + transaction",
    pattern: "{COUNTY}-{TXN3}-{YY}{SEQ:3}",
    cadence: "yearly",
    hint: "Embeds county and transaction; resets yearly.",
  },
  {
    label: "Continuous sequence",
    pattern: "T-{SEQ:6}",
    cadence: "never",
    hint: "Single counter that never resets.",
  },
];

export const Route = createFileRoute("/admin/file-numbering")({
  head: () => ({
    meta: [
      { title: "File numbering · Title Hub" },
      {
        name: "description",
        content:
          "Configure the pattern used for new file numbers and the counter that backs it.",
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
      convexQuery(api.fileNumberPolicy.get, {}),
    );
    void queryClient.ensureQueryData(
      convexQuery(api.fileNumberPolicy.previewBatch, { count: 3 }),
    );
  },
  component: FileNumberingPage,
});

function FileNumberingPage() {
  const current = useQuery(convexQuery(api.tenants.current, {}));
  const policy = useQuery(convexQuery(api.fileNumberPolicy.get, {}));

  if (current.isLoading || policy.isLoading) {
    return (
      <AppShell isAuthenticated title="File numbering">
        <div className="flex flex-col gap-6 pb-12">
          <PageHeaderSkeleton />
          <SectionSkeleton rows={4} />
        </div>
      </AppShell>
    );
  }
  if (current.error) {
    return (
      <AppShell isAuthenticated title="File numbering">
        <p className="text-sm text-destructive">{current.error.message}</p>
      </AppShell>
    );
  }
  if (current.data?.role !== "owner") {
    return (
      <AppShell isAuthenticated title="File numbering">
        <Card className="mx-auto max-w-xl">
          <CardHeader>
            <CardTitle>No access</CardTitle>
            <CardDescription>
              File numbering is owner-only — every file in the firm uses this
              policy.
            </CardDescription>
          </CardHeader>
        </Card>
      </AppShell>
    );
  }

  const data = policy.data as PolicyData;
  return (
    <AppShell
      isAuthenticated
      title="File numbering"
      subtitle="Pattern, counter, and reset cadence for new files."
    >
      <div className="flex flex-col gap-6 pb-12">
        <PolicyEditor key={data.updatedAt ?? "fresh"} data={data} />
      </div>
    </AppShell>
  );
}

function PolicyEditor({ data }: { data: PolicyData }) {
  const [pattern, setPattern] = useState(data.pattern);
  const [seq, setSeq] = useState(data.nextSeq);
  const [cadence, setCadence] = useState<Cadence>(data.seqResetCadence);
  const [pending, setPending] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();
  const setMut = useConvexMutation(api.fileNumberPolicy.set);
  const resetMut = useConvexMutation(api.fileNumberPolicy.reset);

  const dirty =
    pattern !== data.pattern ||
    seq !== data.nextSeq ||
    cadence !== data.seqResetCadence;

  // Local validation mirrors lib/fileNumber.ts. Server is the source of
  // truth — we validate locally to disable Save and surface errors inline.
  const issues = useMemo(() => validatePatternClient(pattern, data.tokens), [
    pattern,
    data.tokens,
  ]);
  const validSeq = Number.isInteger(seq) && seq >= 1;
  const canSave = dirty && issues.length === 0 && validSeq && !pending;

  const insertToken = (raw: string) => {
    const insertion = `{${raw}}`;
    const el = inputRef.current;
    if (!el) {
      setPattern((p) => p + insertion);
      return;
    }
    const start = el.selectionStart ?? pattern.length;
    const end = el.selectionEnd ?? pattern.length;
    const next = pattern.slice(0, start) + insertion + pattern.slice(end);
    setPattern(next);
    requestAnimationFrame(() => {
      el.focus();
      const cursor = start + insertion.length;
      el.setSelectionRange(cursor, cursor);
    });
  };

  const onSave = async () => {
    if (!canSave) return;
    setPending(true);
    try {
      await setMut({
        pattern,
        nextSeq: seq,
        seqResetCadence: cadence,
      });
      setSavedAt(Date.now());
    } finally {
      setPending(false);
    }
  };

  const onReset = async () => {
    if (!data.isCustomized) return;
    const ok = await confirm({
      title: "Reset to default?",
      description:
        "Pattern and counter return to the platform default. Existing files keep their numbers.",
      confirmText: "Reset",
      destructive: true,
    });
    if (!ok) return;
    setPending(true);
    try {
      await resetMut({});
    } finally {
      setPending(false);
    }
  };

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setPattern(preset.pattern);
    setCadence(preset.cadence);
    inputRef.current?.focus();
  };

  return (
    <>
      <Status data={data} dirty={dirty} savedAt={savedAt} />

      <section className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/5">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-[#fdf6e8]/40 px-5 py-3">
          <div className="flex items-center gap-2">
            <Hash className="size-4 text-[#7a5818]" />
            <div className="font-display text-sm font-semibold tracking-tight text-[#40233f]">
              Pattern
            </div>
          </div>
          <div className="text-[11px] text-muted-foreground">
            Tokens are replaced when a file is opened.
          </div>
        </header>
        <div className="grid grid-cols-1 gap-5 p-5 md:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="flex flex-col gap-3 min-w-0">
            <Label className="text-xs font-medium text-[#40233f]">
              Template
            </Label>
            <Input
              ref={inputRef}
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="{YYYY}-{SEQ:4}"
              className="font-mono text-sm tabular-nums"
            />

            <div className="flex flex-col gap-1.5">
              <div className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                Click to insert
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {data.tokens.map((tok) => {
                  const tokenLabel = tok.parameterized
                    ? `${tok.name}:4`
                    : tok.name;
                  return (
                    <button
                      key={tok.name}
                      type="button"
                      onClick={() => insertToken(tokenLabel)}
                      title={`${tok.label} · resolves to "${tok.example}"`}
                      className="group/tok inline-flex items-center gap-1 rounded-full border border-dashed border-border bg-card px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-[transform,color,border-color,background-color] duration-[160ms] ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-[#b78625] hover:bg-[#fdf6e8] hover:text-[#7a5818] active:scale-[0.97]"
                    >
                      <Plus className="size-3" />
                      {`{${tokenLabel}}`}
                      <span className="ml-1 text-muted-foreground/60">
                        {tok.example}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {issues.length > 0 && (
              <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-[#8a3942]">
                {issues.map((i, idx) => (
                  <li key={idx}>· {i}</li>
                ))}
              </ul>
            )}

            <div className="mt-1 flex flex-col gap-1.5">
              <div className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                Presets
              </div>
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((p) => (
                  <button
                    key={p.pattern}
                    type="button"
                    onClick={() => applyPreset(p)}
                    title={p.hint}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-[#40233f] transition-[transform,color,border-color,background-color] duration-[160ms] ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-[#593157] hover:bg-[#f1eaf3] active:scale-[0.97]"
                  >
                    <Sparkles className="size-3 text-[#b78625]" />
                    {p.label}
                    <code className="font-mono text-[10px] text-muted-foreground/80">
                      {p.pattern}
                    </code>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <PatternPreview pattern={pattern} seq={seq} cadence={cadence} />
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 px-5 py-3">
          <CounterControls
            seq={seq}
            onSeq={setSeq}
            cadence={cadence}
            onCadence={setCadence}
            data={data}
          />
          <div className="flex items-center gap-2">
            {data.isCustomized && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={onReset}
              >
                <RotateCcw className="size-3.5" />
                Reset to default
              </Button>
            )}
            <Button size="sm" disabled={!canSave} onClick={onSave}>
              {pending ? "Saving…" : dirty ? "Save" : "Saved"}
            </Button>
          </div>
        </footer>
      </section>
    </>
  );
}

function Status({
  data,
  dirty,
  savedAt,
}: {
  data: PolicyData;
  dirty: boolean;
  savedAt: number | null;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/60 bg-card px-5 py-3 shadow-sm ring-1 ring-foreground/5">
      <div className="flex items-center gap-2 text-sm text-[#40233f]">
        <Hash className="size-4 text-[#7a5818]" />
        <span className="font-medium">
          {data.isCustomized ? "Custom policy" : "Default policy"}
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {data.pattern}
        </span>
      </div>
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        {!dirty && savedAt && (
          <motion.span
            key={savedAt}
            initial={{ transform: "translateY(2px)", opacity: 0 }}
            animate={{ transform: "translateY(0)", opacity: 1 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="font-medium text-[#2f5d4b]"
          >
            Saved · applies to next file
          </motion.span>
        )}
        {dirty && <span>Unsaved changes</span>}
        <span className="font-mono tabular-nums">
          Counter: {data.nextSeq.toLocaleString()}
        </span>
        <span>Reset {data.seqResetCadence}</span>
      </div>
    </div>
  );
}

function PatternPreview({
  pattern,
  seq,
  cadence,
}: {
  pattern: string;
  seq: number;
  cadence: Cadence;
}) {
  const counties = useQuery(convexQuery(api.seed.listIndianaCounties, {}));
  const countyList = counties.data ?? [];

  const [sampleCountyId, setSampleCountyId] = useState<string>("");
  const [sampleTxn, setSampleTxn] = useState<string>("purchase");

  // Default to the first available county once the list arrives so the
  // preview can resolve {COUNTY} / {STATE} on first paint.
  const effectiveCountyId =
    sampleCountyId ||
    (countyList.length > 0 ? (countyList[0]._id as string) : "");

  // Pass the draft pattern + counter + cadence so the server renders the
  // unsaved version against real tenant data. No fallback to local
  // formatting — server is the source of truth.
  const previewParams = useMemo(
    () => ({
      count: 3 as number,
      pattern,
      nextSeq: seq,
      seqResetCadence: cadence,
      countyId: (effectiveCountyId || undefined) as
        | (typeof countyList)[number]["_id"]
        | undefined,
      transactionType: sampleTxn,
    }),
    [pattern, seq, cadence, effectiveCountyId, sampleTxn],
  );
  const remote = useQuery(
    convexQuery(api.fileNumberPolicy.previewBatch, previewParams),
  );

  const previews = (remote.data?.previews ?? []) as ReadonlyArray<string>;
  const invalid = remote.data?.invalid === true;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border/60 bg-[#fdf6e8]/30 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          Next 3 file numbers
        </span>
        {cadence !== "never" && (
          <span className="font-mono text-[10px] text-muted-foreground/80">
            Resets {cadence}
          </span>
        )}
      </div>
      {invalid ? (
        <div className="rounded-md border border-[#b94f58]/30 bg-[#fdecee] px-2 py-1.5 text-[11px] text-[#8a3942]">
          Pattern is invalid. Fix the issues to see a preview.
        </div>
      ) : (
        <ol className="flex flex-col gap-1">
          {previews.length === 0 ? (
            <li className="font-mono text-xs text-muted-foreground/80">
              loading…
            </li>
          ) : (
            previews.map((p, i) => (
              <PreviewLine key={`${p}-${i}`} text={p} primary={i === 0} />
            ))
          )}
        </ol>
      )}
      <SampleSelector
        counties={countyList}
        countyId={effectiveCountyId}
        onCounty={setSampleCountyId}
        txn={sampleTxn}
        onTxn={setSampleTxn}
      />
    </div>
  );
}

function SampleSelector({
  counties,
  countyId,
  onCounty,
  txn,
  onTxn,
}: {
  counties: ReadonlyArray<{ _id: string; name: string; stateCode: string }>;
  countyId: string;
  onCounty: (id: string) => void;
  txn: string;
  onTxn: (t: string) => void;
}) {
  // Compact controls — owners rarely need to change sample inputs, so
  // these stay minimal at the bottom of the preview card.
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-2 text-[10px] tracking-wide text-muted-foreground/80 uppercase">
      <span className="text-[10px] font-semibold tracking-[0.18em]">
        Sample
      </span>
      <select
        value={countyId}
        onChange={(e) => onCounty(e.target.value)}
        className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] tracking-normal text-[#40233f] normal-case focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {counties.length === 0 && <option value="">No counties</option>}
        {counties.map((c) => (
          <option key={c._id} value={c._id}>
            {c.name}, {c.stateCode}
          </option>
        ))}
      </select>
      <select
        value={txn}
        onChange={(e) => onTxn(e.target.value)}
        className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] tracking-normal text-[#40233f] normal-case focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <option value="purchase">Purchase</option>
        <option value="refi">Refinance</option>
        <option value="commercial">Commercial</option>
        <option value="reo">REO</option>
      </select>
    </div>
  );
}

function PreviewLine({
  text,
  primary,
}: {
  text: string;
  primary: boolean;
}) {
  return (
    <motion.li
      key={text}
      initial={{ transform: "translateY(2px)", opacity: 0 }}
      animate={{ transform: "translateY(0)", opacity: 1 }}
      transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
      className={`flex items-center gap-2 font-mono tabular-nums ${
        primary ? "text-base font-semibold text-[#40233f]" : "text-xs text-muted-foreground"
      }`}
    >
      {primary && (
        <span className="size-1.5 rounded-full bg-[#b78625] tk-soft-pulse" />
      )}
      {text || <span className="italic text-[#8a3942]">(empty)</span>}
    </motion.li>
  );
}

function CounterControls({
  seq,
  onSeq,
  cadence,
  onCadence,
  data,
}: {
  seq: number;
  onSeq: (n: number) => void;
  cadence: Cadence;
  onCadence: (c: Cadence) => void;
  data: PolicyData;
}) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="flex flex-col gap-1">
        <Label className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          Next counter
        </Label>
        <Input
          type="number"
          min={1}
          step={1}
          value={seq}
          onChange={(e) => {
            const n = e.target.valueAsNumber;
            if (Number.isFinite(n)) onSeq(Math.floor(n));
          }}
          className="h-8 w-36 font-mono text-sm tabular-nums"
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          Reset cadence
        </Label>
        <Select value={cadence} onValueChange={(v) => onCadence(v as Cadence)}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="never">Never</SelectItem>
            <SelectItem value="yearly">Yearly · Jan 1</SelectItem>
            <SelectItem value="monthly">Monthly · 1st</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {data.seqLastResetBoundary && (
        <div className="font-mono text-[10px] tabular-nums text-muted-foreground/80">
          last reset window: {data.seqLastResetBoundary}
        </div>
      )}
    </div>
  );
}

// ─── Local helpers (mirror server-side validation/format) ────────────────

function validatePatternClient(
  pattern: string,
  tokens: PolicyData["tokens"],
): string[] {
  const issues: string[] = [];
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return ["Pattern cannot be empty."];
  if (trimmed.length > 64)
    issues.push(`Pattern is ${trimmed.length} characters; max is 64.`);
  let hasSeq = false;
  // Token names start with a letter and may contain digits (TXN3, SEQ, …).
  // Lenient on case so we can flag lowercase as a separate issue.
  const re = /\{([A-Za-z][A-Za-z0-9]*)(?::([^}]*))?\}/g;
  const known = new Set(tokens.map((t) => t.name));
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    const [, raw, param] = m;
    if (raw !== raw.toUpperCase()) {
      issues.push(`Token "${raw}" must be uppercase.`);
      continue;
    }
    if (!known.has(raw.toUpperCase())) {
      issues.push(`Unknown token "{${raw}}".`);
      continue;
    }
    const tok = tokens.find((t) => t.name === raw.toUpperCase());
    if (param !== undefined) {
      if (!tok?.parameterized) {
        issues.push(`Token "{${raw}}" doesn't accept a width.`);
      } else if (!/^[1-8]$/.test(param)) {
        issues.push(`Width on "{${raw}:${param}}" must be 1–8.`);
      }
    }
    if (raw.toUpperCase() === "SEQ") hasSeq = true;
  }
  if (!hasSeq)
    issues.push("Pattern must include {SEQ} (or {SEQ:N}) so files don't collide.");
  const literal = trimmed.replace(re, "");
  if (!/^[A-Za-z0-9 _\-./]*$/.test(literal)) {
    issues.push(
      "Use only letters, digits, dashes, underscores, dots, slashes, and spaces between tokens.",
    );
  }
  return issues;
}


