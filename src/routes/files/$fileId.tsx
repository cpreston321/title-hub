import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useAction } from "convex/react";
import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowRight,
  Building2,
  Check,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  History,
  Loader2,
  Lock,
  MapPin,
  Plus,
  RefreshCw,
  ScrollText,
  Sparkles,
  Stamp,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAlert, useConfirm } from "@/components/confirm-dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AppShell } from "@/components/app-shell";
import { Loading } from "@/components/loading";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";

export const Route = createFileRoute("/files/$fileId")({
  head: () => ({
    meta: [
      { title: "File · Title Hub" },
      {
        name: "description",
        content:
          "File of record: property, parties, documents, cross-document checks, and audit trail.",
      },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!(context as { isAuthenticated?: boolean }).isAuthenticated) {
      throw redirect({ to: "/signin" });
    }
  },
  component: FileDetailPage,
});

const STATUS_LABEL: Record<string, string> = {
  opened: "Opened",
  in_exam: "In exam",
  cleared: "Cleared",
  closing: "Closing",
  funded: "Funded",
  recorded: "Recorded",
  policied: "Policy issued",
  cancelled: "Cancelled",
};

function FileDetailPage() {
  const { fileId } = Route.useParams();
  const id = fileId as Id<"files">;
  const detail = useQuery(convexQuery(api.files.get, { fileId: id }));
  const audit = useQuery(convexQuery(api.audit.listForFile, { fileId: id }));
  const extractions = useQuery(
    convexQuery(api.extractions.listForFile, { fileId: id }),
  );
  const findings = useQuery(
    convexQuery(api.reconciliation.listForFile, { fileId: id }),
  );

  if (detail.error) {
    const isMissing = /FILE_NOT_FOUND/i.test(detail.error.message);
    return (
      <AppShell isAuthenticated title="File">
        <FileMissingState
          variant={isMissing ? "missing" : "error"}
          fileId={id}
          rawMessage={detail.error.message}
        />
      </AppShell>
    );
  }

  if (detail.isLoading || !detail.data) {
    return (
      <AppShell isAuthenticated title="File">
        <Loading block size="lg" label="Pulling the file" />
      </AppShell>
    );
  }

  const { file, county, parties, documents } = detail.data;
  const events = audit.data ?? [];

  const confidenceByDoc = new Map<string, Record<string, number>>();
  for (const e of extractions.data ?? []) {
    const payload = e.payload as {
      _confidence?: Record<string, number>;
    } | null;
    if (payload && payload._confidence) {
      confidenceByDoc.set(e.documentId, payload._confidence);
    }
  }

  const extractionByDoc = new Map<
    string,
    { status: string; errorMessage?: string }
  >();
  for (const e of extractions.data ?? []) {
    extractionByDoc.set(e.documentId, {
      status: e.status,
      errorMessage: e.errorMessage,
    });
  }

  const allFindings = (findings.data ?? []) as ReadonlyArray<Finding>;
  const openFindings = allFindings.filter((f) => f.status === "open");
  const blockingCount = openFindings.filter(
    (f) => f.severity === "block",
  ).length;

  // Workflow readiness
  const hasProperty = !!file.propertyAddress?.line1;
  const partiesCount = parties.length;
  const partiesReady = partiesCount >= 2;
  const docsExtracted = documents.filter(
    (d) => extractionByDoc.get(d._id)?.status === "succeeded",
  ).length;
  // One successfully extracted document is enough to make reconcile useful —
  // the engine can already flag missing required document types and validate
  // that doc against the file. Two or more unlocks the cross-document
  // comparisons (price, parties, dates, etc.).
  const docsReady = documents.length >= 1 && docsExtracted >= 1;
  const reconcileReady = hasProperty && partiesReady && docsReady;
  const reconciled = allFindings.length > 0;
  const allClear = reconciled && blockingCount === 0;
  // Anything currently churning at the file level — drives the hero's
  // "thinking..." indicator.
  const inFlightExtractions = documents.filter((d) => {
    const s = extractionByDoc.get(d._id)?.status;
    return s === "pending" || s === "running";
  }).length;
  const fileBusy = inFlightExtractions > 0;

  const subtitle = `${file.transactionType.charAt(0).toUpperCase() + file.transactionType.slice(1)} · ${county?.name} County, ${file.stateCode}`;

  return (
    <FileDetailContent
      id={id}
      file={file}
      county={county}
      parties={parties}
      documents={documents}
      events={events}
      extractions={extractions.data ?? []}
      confidenceByDoc={confidenceByDoc}
      allFindings={allFindings}
      openFindings={openFindings}
      hasProperty={hasProperty}
      partiesCount={partiesCount}
      partiesReady={partiesReady}
      docsExtracted={docsExtracted}
      docsReady={docsReady}
      reconcileReady={reconcileReady}
      reconciled={reconciled}
      allClear={allClear}
      blockingCount={blockingCount}
      inFlightExtractions={inFlightExtractions}
      fileBusy={fileBusy}
      subtitle={subtitle}
    />
  );
}

type FileDetailContentProps = {
  id: Id<"files">;
  file: Doc<"files">;
  county: Doc<"counties"> | null;
  parties: Array<{
    fileParty: Doc<"fileParties">;
    party: Doc<"parties">;
  }>;
  documents: Array<Doc<"documents">>;
  events: ReadonlyArray<AuditEvent>;
  extractions: ReadonlyArray<ExtractionLite>;
  confidenceByDoc: Map<string, Record<string, number>>;
  allFindings: ReadonlyArray<Finding>;
  openFindings: ReadonlyArray<Finding>;
  hasProperty: boolean;
  partiesCount: number;
  partiesReady: boolean;
  docsExtracted: number;
  docsReady: boolean;
  reconcileReady: boolean;
  reconciled: boolean;
  allClear: boolean;
  blockingCount: number;
  inFlightExtractions: number;
  fileBusy: boolean;
  subtitle: string;
};

// Empty state for /files/$fileId when the requested id resolves to nothing
// — usually because the file was hard-deleted in another tab or via the
// admin CLI. Distinguishes the "expected" missing case from a true server
// error so the operator gets a clear next step instead of a stack trace.
function FileMissingState({
  variant,
  fileId,
  rawMessage,
}: {
  variant: "missing" | "error";
  fileId: Id<"files">;
  rawMessage: string;
}) {
  const isMissing = variant === "missing";
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-16 text-center">
      <div
        className={`grid size-14 place-items-center rounded-full ring-1 ring-inset ${
          isMissing
            ? "bg-[#fdf6e8] text-[#7a5818] ring-[#b78625]/30"
            : "bg-[#fdecee] text-[#8a3942] ring-[#b94f58]/30"
        }`}
      >
        {isMissing ? (
          <FileText className="size-6" />
        ) : (
          <CircleAlert className="size-6" />
        )}
      </div>
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-semibold text-[#40233f]">
          {isMissing ? "This file no longer exists" : "Couldn't load this file"}
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {isMissing
            ? "This file has been removed. Anything that was attached to it has been moved back to triage where applicable."
            : "Something went wrong loading this file. Try again — if it keeps happening, copy the message below to support."}
        </p>
      </div>
      <div className="font-numerals rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
        {fileId}
      </div>
      {!isMissing && (
        <details className="w-full max-w-md text-left">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Show server message
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-card/70 p-2 text-[11px] leading-tight text-foreground/70 ring-1 ring-border ring-inset">
            {rawMessage}
          </pre>
        </details>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <Button asChild>
          <Link to="/files">
            <ArrowRight className="size-3.5 -scale-x-100" />
            Back to all files
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/mail">Check the inbox</Link>
        </Button>
      </div>
    </div>
  );
}

function FileDetailContent({
  id,
  file,
  county,
  parties,
  documents,
  events,
  extractions,
  confidenceByDoc,
  allFindings,
  openFindings,
  hasProperty,
  partiesCount,
  partiesReady,
  docsExtracted,
  docsReady,
  reconcileReady,
  reconciled,
  allClear,
  blockingCount,
  inFlightExtractions,
  fileBusy,
  subtitle,
}: FileDetailContentProps) {
  const [previewDocId, setPreviewDocId] = useState<Id<"documents"> | null>(
    null,
  );

  return (
    <DocumentPreviewContext.Provider value={setPreviewDocId}>
      <AppShell
        isAuthenticated
        breadcrumb={[
          { label: "Files", to: "/files" },
          { label: file.fileNumber },
        ]}
        subtitle={subtitle}
      >
        <div className="flex flex-col gap-6 pb-12">
          <FileHero
            file={file}
            countyName={county?.name ?? "—"}
            partiesCount={partiesCount}
            openFindings={openFindings.length}
            allClear={allClear}
            inFlightExtractions={inFlightExtractions}
            fileBusy={fileBusy}
            statusControl={<HeaderStatus fileId={id} status={file.status} />}
          />

          <LiveActivityRail
            documents={documents}
            extractions={extractions}
            events={events}
          />

          <WorkflowRibbon
            property={hasProperty}
            partiesCount={partiesCount}
            partiesReady={partiesReady}
            docsCount={documents.length}
            docsExtracted={docsExtracted}
            docsReady={docsReady}
            reconcileReady={reconcileReady}
            reconciled={reconciled}
            allClear={allClear}
            blockingCount={blockingCount}
          />

          <PropertyDetailsPanel fileId={id} file={file} />

          <PartiesPanel fileId={id} parties={parties} />

          <DocumentsPanel fileId={id} documents={documents} />

          <PublicRecordsPanel fileId={id} hasProperty={hasProperty} />

          <ReconciliationPanel
            fileId={id}
            documents={documents}
            extractions={extractions}
            confidenceByDoc={confidenceByDoc}
            findings={allFindings}
            reconcileReady={reconcileReady}
            missingPrereqs={{
              property: !hasProperty,
              parties: !partiesReady,
              docs: !docsReady,
            }}
          />

          <ReconciledFactsPanel file={file} />

          <RulesPanel fileId={id} />

          <AuditPanel events={events} />
        </div>
      </AppShell>
      <DocumentPreviewSheet
        documentId={previewDocId}
        documents={documents}
        onOpenChange={(open) => {
          if (!open) setPreviewDocId(null);
        }}
      />
    </DocumentPreviewContext.Provider>
  );
}

type StatusValue =
  | "opened"
  | "in_exam"
  | "cleared"
  | "closing"
  | "funded"
  | "recorded"
  | "policied"
  | "cancelled";

const STATUS_FLOW: ReadonlyArray<StatusValue> = [
  "opened",
  "in_exam",
  "cleared",
  "closing",
  "funded",
  "recorded",
  "policied",
];

const STATUS_HINT: Record<StatusValue, string> = {
  opened: "New file, awaiting documents",
  in_exam: "Extraction and reconciliation in progress",
  cleared: "Cross-document checks pass",
  closing: "Closing scheduled or underway",
  funded: "Funds disbursed",
  recorded: "Documents on record at the county",
  policied: "Policy issued — terminal",
  cancelled: "Cancelled — no policy will issue",
};

function statusTone(status: string) {
  if (status === "policied")
    return {
      ring: "ring-[#3f7c64]/40",
      text: "text-[#2f5d4b]",
      bg: "bg-[#e6f3ed]",
      dot: "bg-[#3f7c64]",
    };
  if (status === "closing" || status === "funded" || status === "recorded")
    return {
      ring: "ring-[#b78625]/45",
      text: "text-[#7a5818]",
      bg: "bg-[#f8eed7]",
      dot: "bg-[#b78625]",
    };
  if (status === "cleared")
    return {
      ring: "ring-[#3f668f]/40",
      text: "text-[#2c4a6b]",
      bg: "bg-[#e8f0f8]",
      dot: "bg-[#3f668f]",
    };
  if (status === "in_exam" || status === "opened")
    return {
      ring: "ring-[#593157]/35",
      text: "text-[#40233f]",
      bg: "bg-[#f2e7f1]",
      dot: "bg-[#593157]",
    };
  if (status === "cancelled")
    return {
      ring: "ring-[#b94f58]/45",
      text: "text-[#8a3942]",
      bg: "bg-[#fdecee]",
      dot: "bg-[#b94f58]",
    };
  return {
    ring: "ring-border",
    text: "text-muted-foreground",
    bg: "bg-muted",
    dot: "bg-muted-foreground",
  };
}

function HeaderStatus({
  fileId,
  status,
}: {
  fileId: Id<"files">;
  status: string;
}) {
  const setStatus = useConvexMutation(api.files.setStatus);
  const [pending, setPending] = useState<StatusValue | null>(null);
  const tone = statusTone(status);
  const alert = useAlert();

  const onPick = async (next: StatusValue) => {
    if (next === status) return;
    setPending(next);
    try {
      await setStatus({ fileId, status: next });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The audit trail will not have changed; surface the failure in a
      // dialog so the operator notices it.
      await alert({
        title: "Could not change status",
        description: msg.replace(/^.*ConvexError:\s*/, ""),
      });
    } finally {
      setPending(null);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Change file status"
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ring-1 transition outline-none ring-inset focus-visible:ring-2 focus-visible:ring-[#40233f]/40 ${tone.ring} ${tone.text} ${tone.bg} hover:brightness-[0.97]`}
          disabled={pending !== null}
        >
          <span className={`size-1.5 rounded-full ${tone.dot}`} />
          {STATUS_LABEL[status] ?? status}
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        <DropdownMenuLabel className="text-[10px] font-semibold tracking-wide text-[#b78625] uppercase">
          Lifecycle
        </DropdownMenuLabel>
        {STATUS_FLOW.map((s) => {
          const t = statusTone(s);
          const isCurrent = s === status;
          return (
            <DropdownMenuItem
              key={s}
              onSelect={(e) => {
                e.preventDefault();
                onPick(s);
              }}
              disabled={isCurrent || pending !== null}
              className="items-start"
            >
              <span
                className={`mt-1 size-1.5 shrink-0 rounded-full ${t.dot}`}
                aria-hidden
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2">
                  <span className="font-medium text-foreground">
                    {STATUS_LABEL[s]}
                  </span>
                  {isCurrent && (
                    <span className="text-[10px] font-medium text-muted-foreground">
                      current
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {STATUS_HINT[s]}
                </span>
              </span>
              {isCurrent && (
                <Check className="mt-0.5 ml-1 size-3.5 text-[#3f7c64]" />
              )}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={(e) => {
            e.preventDefault();
            onPick("cancelled");
          }}
          disabled={status === "cancelled" || pending !== null}
          className="items-start"
        >
          <span
            className="mt-1 size-1.5 shrink-0 rounded-full bg-[#b94f58]"
            aria-hidden
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-2">
              <span className="font-medium">Cancel file</span>
              {status === "cancelled" && (
                <span className="text-[10px] font-medium text-muted-foreground">
                  current
                </span>
              )}
            </span>
            <span className="text-xs">{STATUS_HINT.cancelled}</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FileHero({
  file,
  countyName,
  partiesCount,
  openFindings,
  allClear,
  inFlightExtractions,
  fileBusy,
  statusControl,
}: {
  file: Doc<"files">;
  countyName: string;
  partiesCount: number;
  openFindings: number;
  allClear: boolean;
  inFlightExtractions: number;
  fileBusy: boolean;
  statusControl?: React.ReactNode;
}) {
  const addr = file.propertyAddress;
  const addrLine = addr
    ? `${addr.line1}${addr.line2 ? `, ${addr.line2}` : ""} · ${addr.city}, ${addr.state} ${addr.zip}`
    : null;
  const opened = new Date(file.openedAt);
  const target = file.targetCloseDate ? new Date(file.targetCloseDate) : null;
  const daysToClose = target
    ? Math.ceil((target.getTime() - Date.now()) / (24 * 3600 * 1000))
    : null;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/70 bg-card shadow-md ring-1 ring-foreground/5">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 paper-grain opacity-50"
      />
      <div className="relative grid grid-cols-1 gap-6 px-6 py-6 md:grid-cols-[1.4fr_auto] md:items-center md:gap-10 md:px-8 md:py-7">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-[#b78625]">
            <FileText className="size-3.5" />
            File of record
            {fileBusy && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#fdf6e8] px-2 py-0.5 text-[11px] font-medium text-[#7a5818] ring-1 ring-[#b78625]/30 ring-inset">
                <Sparkles className="tk-soft-pulse size-3" />
                Processing {inFlightExtractions}{" "}
                {inFlightExtractions === 1 ? "doc" : "docs"}
                <span className="inline-flex gap-0.5 leading-none">
                  <span className="tk-dot inline-block">.</span>
                  <span className="tk-dot inline-block" data-i="1">
                    .
                  </span>
                  <span className="tk-dot inline-block" data-i="2">
                    .
                  </span>
                </span>
              </span>
            )}
            {statusControl && (
              <span className="ml-auto md:ml-2">{statusControl}</span>
            )}
          </div>
          <h1 className="font-numerals mt-1.5 text-3xl leading-none font-semibold tracking-tight text-[#40233f] md:text-4xl">
            {file.fileNumber}
          </h1>
          <div className="mt-3 flex items-start gap-2 text-sm text-foreground/85">
            <MapPin className="mt-0.5 size-4 shrink-0 text-[#b78625]" />
            <div className="min-w-0">
              {addrLine ?? (
                <span className="text-muted-foreground">
                  No property address yet —{" "}
                  <a
                    href="#step-property"
                    className="font-medium text-[#40233f] underline underline-offset-2 hover:text-[#593157]"
                  >
                    add it in step 1
                  </a>
                  .
                </span>
              )}
              <div className="mt-0.5 text-xs text-muted-foreground">
                {countyName} County, {file.stateCode} ·{" "}
                <span className="capitalize">{file.transactionType}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border/70 ring-1 ring-foreground/5 md:grid-cols-4">
          <Stat
            label="Opened"
            value={opened.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            })}
            sub={opened.getFullYear().toString()}
          />
          <Stat
            label="Target close"
            value={
              target
                ? target.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })
                : "—"
            }
            sub={
              daysToClose === null
                ? "not set"
                : daysToClose < 0
                  ? `${Math.abs(daysToClose)}d overdue`
                  : daysToClose === 0
                    ? "today"
                    : `in ${daysToClose}d`
            }
            tone={
              daysToClose !== null && daysToClose < 0
                ? "warn"
                : daysToClose !== null && daysToClose <= 7
                  ? "amber"
                  : undefined
            }
          />
          <Stat
            label="Parties"
            value={String(partiesCount).padStart(2, "0")}
            sub={
              partiesCount === 0
                ? "none yet"
                : partiesCount < 2
                  ? "need ≥2"
                  : "on file"
            }
          />
          <Stat
            label="Findings"
            value={allClear ? "✓" : String(openFindings).padStart(2, "0")}
            sub={
              allClear
                ? "all clear"
                : openFindings === 0
                  ? "not run yet"
                  : "open"
            }
            tone={allClear ? "good" : openFindings > 0 ? "warn" : undefined}
          />
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "warn" | "amber";
}) {
  const valueClass =
    tone === "good"
      ? "text-[#2f5d4b]"
      : tone === "warn"
        ? "text-[#8a3942]"
        : tone === "amber"
          ? "text-[#7a5818]"
          : "text-[#40233f]";
  return (
    <div className="bg-card px-4 py-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div
        className={`mt-1 font-display text-xl leading-none font-semibold tabular-nums ${valueClass}`}
      >
        {value}
      </div>
      {sub && (
        <div className="font-numerals mt-1 text-xs text-muted-foreground">
          {sub}
        </div>
      )}
    </div>
  );
}

function WorkflowRibbon({
  property,
  partiesCount,
  partiesReady,
  docsCount,
  docsExtracted,
  docsReady,
  reconcileReady,
  reconciled,
  allClear,
  blockingCount,
}: {
  property: boolean;
  partiesCount: number;
  partiesReady: boolean;
  docsCount: number;
  docsExtracted: number;
  docsReady: boolean;
  reconcileReady: boolean;
  reconciled: boolean;
  allClear: boolean;
  blockingCount: number;
}) {
  const steps: Array<{
    n: number;
    label: string;
    anchor: string;
    state: "done" | "todo" | "pending";
    detail: string;
  }> = [
    {
      n: 1,
      label: "Property",
      anchor: "#step-property",
      state: property ? "done" : "todo",
      detail: property ? "Address on file" : "Add the property address",
    },
    {
      n: 2,
      label: "Parties",
      anchor: "#step-parties",
      state: partiesReady ? "done" : partiesCount > 0 ? "pending" : "todo",
      detail: partiesReady
        ? `${partiesCount} on file`
        : partiesCount > 0
          ? `${partiesCount} on file · need ≥ 2`
          : "Add buyer and seller",
    },
    {
      n: 3,
      label: "Documents",
      anchor: "#step-documents",
      state: docsReady ? "done" : docsCount > 0 ? "pending" : "todo",
      detail: docsReady
        ? docsExtracted >= 2
          ? `${docsCount} uploaded · ${docsExtracted} extracted`
          : `${docsExtracted} extracted — add another doc for richer findings`
        : docsCount === 0
          ? "Upload at least one — PA, commitment, etc."
          : `${docsCount} uploaded · waiting on extraction`,
    },
    {
      n: 4,
      label: "Reconcile",
      anchor: "#step-reconcile",
      state: allClear
        ? "done"
        : reconciled
          ? "pending"
          : reconcileReady
            ? "pending"
            : "todo",
      detail: allClear
        ? "All clear"
        : reconciled
          ? `${blockingCount} blocker${blockingCount === 1 ? "" : "s"} open`
          : reconcileReady
            ? "Ready to run"
            : "Finish steps 1–3",
    },
  ];

  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm ring-1 ring-foreground/5">
      <div className="flex items-center justify-between border-b border-border/60 bg-[#fdf6e8]/60 px-5 py-2.5">
        <div className="flex items-center gap-2 text-xs font-semibold text-[#b78625]">
          <Sparkles className="size-3.5" />
          Workflow
        </div>
        <div className="text-xs text-muted-foreground">
          Each step unlocks the next. Reconciliation is most useful when 1–3 are
          green.
        </div>
      </div>
      <ol className="grid grid-cols-1 divide-y divide-border/60 sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
        {steps.map((s, i) => (
          <li key={s.n} className="relative">
            <a
              href={s.anchor}
              className="group/step flex h-full items-start gap-3 px-5 py-4 transition hover:bg-[#fdf6e8]/40"
            >
              <StepBadge n={s.n} state={s.state} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <div className="font-display text-base leading-none font-semibold tracking-tight text-[#40233f]">
                    {s.label}
                  </div>
                  <div className="text-xs font-medium text-muted-foreground">
                    Step {s.n}
                  </div>
                </div>
                <div
                  className={`mt-1 text-xs leading-snug ${
                    s.state === "done"
                      ? "text-[#2f5d4b]"
                      : s.state === "pending"
                        ? "text-[#7a5818]"
                        : "text-muted-foreground"
                  }`}
                >
                  {s.detail}
                </div>
              </div>
              {i < steps.length - 1 && (
                <ArrowRight className="size-3.5 shrink-0 self-center text-muted-foreground/30 group-hover/step:text-[#40233f]" />
              )}
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StepBadge({
  n,
  state,
}: {
  n: number;
  state: "done" | "todo" | "pending";
}) {
  if (state === "done") {
    return (
      <div className="grid size-8 shrink-0 place-items-center rounded-full bg-[#3f7c64] text-white ring-2 ring-[#e6f3ed]">
        <Check className="size-4" />
      </div>
    );
  }
  if (state === "pending") {
    return (
      <div className="font-numerals grid size-8 shrink-0 place-items-center rounded-full bg-[#f8eed7] text-xs font-semibold text-[#7a5818] tabular-nums ring-2 ring-[#fdf6e8]">
        {n}
      </div>
    );
  }
  return (
    <div className="font-numerals grid size-8 shrink-0 place-items-center rounded-full bg-card text-xs font-semibold text-muted-foreground tabular-nums ring-1 ring-border ring-inset">
      {n}
    </div>
  );
}

function SectionShell({
  id,
  step,
  done,
  eyebrow,
  title,
  description,
  icon,
  actions,
  children,
}: {
  id?: string;
  step?: number;
  done?: boolean;
  eyebrow: string;
  title: string;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <article
      id={id}
      className="[scroll-margin-top:6rem] overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/5"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 px-6 pt-5 pb-4">
        <div className="flex min-w-0 items-start gap-3">
          {step !== undefined && (
            <div className="mt-0.5">
              <StepBadge n={step} state={done ? "done" : "todo"} />
            </div>
          )}
          {icon && step === undefined && (
            <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-[#40233f]/15 bg-[#fdf6e8] text-[#40233f]">
              {icon}
            </div>
          )}
          <div className="min-w-0">
            <div className="text-xs font-semibold text-[#b78625]">
              {eyebrow}
            </div>
            <h2 className="font-display text-xl font-semibold tracking-tight text-[#40233f]">
              {title}
            </h2>
            {description && (
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
            )}
          </div>
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </header>
      <div className="px-6 py-5">{children}</div>
    </article>
  );
}

function PropertyDetailsPanel({
  fileId,
  file,
}: {
  fileId: Id<"files">;
  file: Doc<"files">;
}) {
  const update = useConvexMutation(api.files.update);
  const [edit, setEdit] = useState(!file.propertyAddress?.line1);
  const [transactionType, setTransactionType] = useState(file.transactionType);
  const [propertyApn, setPropertyApn] = useState(file.propertyApn ?? "");
  const [line1, setLine1] = useState(file.propertyAddress?.line1 ?? "");
  const [line2, setLine2] = useState(file.propertyAddress?.line2 ?? "");
  const [city, setCity] = useState(file.propertyAddress?.city ?? "");
  const [stateCode, setStateCode] = useState(
    file.propertyAddress?.state ?? file.stateCode,
  );
  const [zip, setZip] = useState(file.propertyAddress?.zip ?? "");
  const [targetCloseDate, setTargetCloseDate] = useState(
    file.targetCloseDate
      ? new Date(file.targetCloseDate).toISOString().slice(0, 10)
      : "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const addrFilled =
        line1.trim() && city.trim() && stateCode.trim() && zip.trim();
      await update({
        fileId,
        transactionType,
        propertyApn: propertyApn.trim(),
        propertyAddress: addrFilled
          ? {
              line1: line1.trim(),
              line2: line2.trim() || undefined,
              city: city.trim(),
              state: stateCode.trim(),
              zip: zip.trim(),
            }
          : undefined,
        targetCloseDate: targetCloseDate
          ? new Date(targetCloseDate).getTime()
          : undefined,
      });
      setEdit(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.replace(/^.*ConvexError:\s*/, ""));
    } finally {
      setPending(false);
    }
  };

  const addr = file.propertyAddress;
  const addrLine = addr
    ? `${addr.line1}${addr.line2 ? `, ${addr.line2}` : ""}, ${addr.city}, ${addr.state} ${addr.zip}`
    : null;
  const done = !!addr?.line1;

  return (
    <SectionShell
      id="step-property"
      step={1}
      done={done}
      eyebrow="The property"
      title="Property details"
      description="Where the transaction lives. Used by reconciliation to match what's in the documents."
      actions={
        <Button variant="outline" size="sm" onClick={() => setEdit(!edit)}>
          {edit ? "Cancel" : addrLine ? "Edit" : "Add details"}
        </Button>
      }
    >
      {edit ? (
        <form onSubmit={onSave} className="grid gap-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <FieldGroup label="Transaction type" hint="Drives recording rules">
              <Select
                value={transactionType}
                onValueChange={setTransactionType}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="purchase">Purchase</SelectItem>
                  <SelectItem value="refi">Refinance</SelectItem>
                  <SelectItem value="commercial">Commercial</SelectItem>
                  <SelectItem value="reo">REO</SelectItem>
                </SelectContent>
              </Select>
            </FieldGroup>
            <FieldGroup label="Target close" hint="Optional, used in calendar">
              <Input
                type="date"
                value={targetCloseDate}
                onChange={(e) => setTargetCloseDate(e.target.value)}
                className="font-numerals"
              />
            </FieldGroup>
          </div>

          <FieldGroup label="APN" hint="Assessor's parcel number, if known">
            <Input
              value={propertyApn}
              onChange={(e) => setPropertyApn(e.target.value)}
              className="font-numerals"
            />
          </FieldGroup>

          <FieldGroup label="Address line 1" required>
            <Input
              value={line1}
              onChange={(e) => setLine1(e.target.value)}
              placeholder="123 Main St"
            />
          </FieldGroup>
          <FieldGroup label="Address line 2" hint="Apt, unit, suite — optional">
            <Input value={line2} onChange={(e) => setLine2(e.target.value)} />
          </FieldGroup>
          <div className="grid grid-cols-3 gap-4">
            <FieldGroup label="City" required>
              <Input value={city} onChange={(e) => setCity(e.target.value)} />
            </FieldGroup>
            <FieldGroup label="State" required>
              <Input
                value={stateCode}
                onChange={(e) => setStateCode(e.target.value)}
                maxLength={2}
                className="font-numerals uppercase"
              />
            </FieldGroup>
            <FieldGroup label="ZIP" required>
              <Input
                value={zip}
                onChange={(e) => setZip(e.target.value)}
                className="font-numerals"
              />
            </FieldGroup>
          </div>
          {(() => {
            const filled = [line1, city, stateCode, zip].map((v) => v.trim());
            const allFilled = filled.every(Boolean);
            const anyFilled = filled.some(Boolean);
            const partialAddr = anyFilled && !allFilled;
            return (
              <>
                {partialAddr && (
                  <p className="rounded-md border border-[#b78625]/35 bg-[#fdf6e8] px-3 py-2 text-sm text-[#7a5818]">
                    Fill in all four address fields, or clear them all if you
                    want to save the file without an address yet.
                  </p>
                )}
                {error && (
                  <p className="rounded-md border border-[#b94f58]/30 bg-[#fdecee] px-3 py-2 text-sm text-[#8a3942]">
                    {error}
                  </p>
                )}
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    <span className="text-[#b94f58]">*</span> required when
                    setting an address
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setEdit(false)}
                    >
                      Cancel
                    </Button>
                    <Button type="submit" disabled={pending || partialAddr}>
                      {pending ? "Saving..." : "Save details"}
                    </Button>
                  </div>
                </div>
              </>
            );
          })()}
        </form>
      ) : addrLine ? (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <KV label="Address" value={addrLine} />
          <KV label="APN" value={file.propertyApn || "—"} mono />
          <KV
            label="Transaction"
            value={<span className="capitalize">{file.transactionType}</span>}
          />
          <KV
            label="Target close"
            value={
              file.targetCloseDate
                ? new Date(file.targetCloseDate).toLocaleDateString("en-US", {
                    dateStyle: "medium",
                  })
                : "—"
            }
            mono
          />
        </dl>
      ) : (
        <EmptyHint
          icon={<MapPin className="size-4" />}
          title="No property on file yet"
          body="Add the address and a target close date so we know what we're working with."
        />
      )}
    </SectionShell>
  );
}

function FieldGroup({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-[#40233f]">
        {label}
        {required && (
          <span className="ml-1 text-[#b94f58]" aria-hidden>
            *
          </span>
        )}
      </span>
      {children}
      {hint && (
        <span className="text-xs leading-snug text-muted-foreground">
          {hint}
        </span>
      )}
    </label>
  );
}

function KV({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd
        className={`text-sm text-foreground/90 ${mono ? "font-numerals tabular-nums" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

function EmptyHint({
  icon,
  title,
  body,
}: {
  icon?: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-dashed border-border bg-[#fdf6e8]/40 px-4 py-3 text-sm">
      {icon && (
        <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-card text-[#40233f] ring-1 ring-border">
          {icon}
        </div>
      )}
      <div className="min-w-0">
        <div className="font-medium text-[#40233f]">{title}</div>
        <div className="text-xs leading-snug text-muted-foreground">{body}</div>
      </div>
    </div>
  );
}

function PartiesPanel({
  fileId,
  parties,
}: {
  fileId: Id<"files">;
  parties: ReadonlyArray<{
    fileParty: { _id: string; role: string; capacity?: string };
    party: {
      _id: string;
      legalName: string;
      partyType: string;
      einOrSsnToken?: string;
    };
  }>;
}) {
  const addParty = useConvexMutation(api.files.addParty);
  const [show, setShow] = useState(false);
  const [legalName, setLegalName] = useState("");
  const [role, setRole] = useState("buyer");
  const [partyType, setPartyType] = useState<
    "person" | "entity" | "trust" | "estate"
  >("person");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await addParty({ fileId, legalName, role, partyType });
      setShow(false);
      setLegalName("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.replace(/^.*ConvexError:\s*/, ""));
    } finally {
      setPending(false);
    }
  };

  const done = parties.length >= 2;

  return (
    <SectionShell
      id="step-parties"
      step={2}
      done={done}
      eyebrow="The people"
      title="Parties"
      description="Buyer, seller, lender, signers. Reconciliation cross-checks names and capacities across documents."
      actions={
        <Button
          onClick={() => setShow(!show)}
          variant={show ? "outline" : "default"}
          size="sm"
          className="gap-1.5"
        >
          {show ? <X className="size-3.5" /> : <Plus className="size-3.5" />}
          {show ? "Cancel" : "Add party"}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {show && (
          <form
            onSubmit={onSubmit}
            className="rounded-xl border border-border/70 bg-[#fdf6e8]/40 p-4"
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[2fr_1fr_1fr]">
              <FieldGroup
                label="Legal name"
                hint="As it should appear on docs"
                required
              >
                <Input
                  value={legalName}
                  onChange={(e) => setLegalName(e.target.value)}
                  placeholder="Jane A. Doe"
                  required
                />
              </FieldGroup>
              <FieldGroup label="Type">
                <Select
                  value={partyType}
                  onValueChange={(v) =>
                    setPartyType(v as "person" | "entity" | "trust" | "estate")
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="person">Person</SelectItem>
                    <SelectItem value="entity">Entity</SelectItem>
                    <SelectItem value="trust">Trust</SelectItem>
                    <SelectItem value="estate">Estate</SelectItem>
                  </SelectContent>
                </Select>
              </FieldGroup>
              <FieldGroup label="Role">
                <Select value={role} onValueChange={setRole}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="buyer">Buyer</SelectItem>
                    <SelectItem value="seller">Seller</SelectItem>
                    <SelectItem value="lender">Lender</SelectItem>
                    <SelectItem value="borrower">Borrower</SelectItem>
                    <SelectItem value="trustee">Trustee</SelectItem>
                    <SelectItem value="signer">Signer</SelectItem>
                  </SelectContent>
                </Select>
              </FieldGroup>
            </div>
            {error && (
              <p className="mt-3 rounded-md border border-[#b94f58]/30 bg-[#fdecee] px-3 py-2 text-sm text-[#8a3942]">
                {error}
              </p>
            )}
            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="text-xs text-muted-foreground">
                {!legalName.trim() && "Enter a legal name to continue."}
              </div>
              <Button
                type="submit"
                disabled={pending || !legalName.trim()}
                size="sm"
              >
                {pending ? "Adding..." : "Add party"}
              </Button>
            </div>
          </form>
        )}

        {parties.length === 0 ? (
          <EmptyHint
            icon={<Users className="size-4" />}
            title="No parties yet"
            body="Add at least one buyer and one seller to enable cross-document checks."
          />
        ) : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {parties.map(({ fileParty, party }) => (
              <li
                key={fileParty._id}
                className="flex flex-col gap-2 rounded-xl border border-border/60 bg-card px-4 py-3 ring-1 ring-foreground/5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-[#2e2430]">
                      {party.legalName}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <RolePill role={fileParty.role} />
                      <span className="text-xs text-muted-foreground">
                        {party.partyType}
                        {fileParty.capacity ? ` · ${fileParty.capacity}` : ""}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="border-t border-border/50 pt-2">
                  <NpiCell
                    fileId={fileId}
                    partyId={party._id as Id<"parties">}
                    token={party.einOrSsnToken}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionShell>
  );
}

function RolePill({ role }: { role: string }) {
  const tone =
    role === "buyer" || role === "borrower"
      ? "bg-[#e8f0f8] text-[#2c4a6b] ring-[#3f668f]/30"
      : role === "seller"
        ? "bg-[#fde9dc] text-[#7a3d18] ring-[#c9652e]/30"
        : role === "lender"
          ? "bg-[#f2e7f1] text-[#40233f] ring-[#593157]/30"
          : "bg-muted text-muted-foreground ring-border";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}
    >
      {role}
    </span>
  );
}

function NpiCell({
  fileId,
  partyId,
  token,
}: {
  fileId: Id<"files">;
  partyId: Id<"parties">;
  token?: string;
}) {
  const issue = useConvexMutation(api.secrets.issue);
  const reveal = useConvexMutation(api.secrets.reveal);
  const setSecretToken = useConvexMutation(api.parties.setSecretToken);

  const [show, setShow] = useState(false);
  const [fieldKind, setFieldKind] = useState<"ssn" | "ein" | "account" | "dob">(
    "ssn",
  );
  const [plaintext, setPlaintext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token: t } = await issue({ fieldKind, plaintext });
      await setSecretToken({ partyId, token: t });
      setShow(false);
      setPlaintext("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.replace(/^.*ConvexError:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const onReveal = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const r = await reveal({ token, fileId, purpose: "file_detail_view" });
      setRevealed(r.plaintext);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.replace(/^.*ConvexError:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <div>
        {show ? (
          <form
            onSubmit={onAdd}
            className="flex flex-wrap items-center gap-1.5"
          >
            <Select
              value={fieldKind}
              onValueChange={(v) =>
                setFieldKind(v as "ssn" | "ein" | "account" | "dob")
              }
            >
              <SelectTrigger size="sm" className="text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ssn">SSN</SelectItem>
                <SelectItem value="ein">EIN</SelectItem>
                <SelectItem value="account">Account</SelectItem>
                <SelectItem value="dob">DOB</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="text"
              autoComplete="off"
              placeholder="123-45-6789"
              className="font-numerals h-8 max-w-[10rem] text-xs"
              value={plaintext}
              onChange={(e) => setPlaintext(e.target.value)}
              required
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={busy || !plaintext.trim()}
            >
              {busy ? "..." : "Save"}
            </Button>
            <button
              type="button"
              onClick={() => setShow(false)}
              className="text-xs text-muted-foreground hover:text-[#40233f]"
            >
              cancel
            </button>
            {error && <span className="text-xs text-[#8a3942]">{error}</span>}
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setShow(true)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground transition hover:text-[#40233f]"
          >
            <Lock className="size-3" />
            Add SSN / EIN / Account
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <Lock className="size-3 text-[#b78625]" />
      <span className="text-muted-foreground">NPI on file:</span>
      <code className="font-numerals rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums">
        {revealed ?? "••••••••"}
      </code>
      {revealed ? (
        <button
          type="button"
          onClick={() => setRevealed(null)}
          className="flex items-center gap-1 text-muted-foreground transition hover:text-[#40233f]"
        >
          <EyeOff className="size-3" />
          hide
        </button>
      ) : (
        <button
          type="button"
          onClick={onReveal}
          disabled={busy}
          className="flex items-center gap-1 text-[#40233f] transition hover:text-[#593157] disabled:opacity-50"
        >
          <Eye className="size-3" />
          {busy ? "..." : "reveal"}
        </button>
      )}
      {error && <span className="text-[#8a3942]">{error}</span>}
    </div>
  );
}

function DocumentsPanel({
  fileId,
  documents,
}: {
  fileId: Id<"files">;
  documents: ReadonlyArray<{
    _id: string;
    title?: string;
    docType: string;
    sizeBytes?: number;
    uploadedAt: number;
  }>;
}) {
  const generateUploadUrl = useConvexMutation(api.files.generateUploadUrl);
  const recordDocument = useConvexMutation(api.files.recordDocument);
  const [docType, setDocType] = useState("purchase_agreement");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      const uploadUrl = await generateUploadUrl({});
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": f.type },
        body: f,
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const { storageId } = (await res.json()) as { storageId: string };
      await recordDocument({
        fileId,
        storageId: storageId as Id<"_storage">,
        docType,
        title: f.name,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  };

  return (
    <SectionShell
      id="step-documents"
      step={3}
      done={documents.length >= 2}
      eyebrow="The evidence"
      title="Documents"
      description="Upload the purchase agreement, counter offers, commitment, and so on. Extraction runs automatically. One doc lets reconcile flag what's missing; two or more unlocks cross-document checks."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Select value={docType} onValueChange={setDocType}>
            <SelectTrigger size="sm" className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="purchase_agreement">
                Purchase agreement
              </SelectItem>
              <SelectItem value="counter_offer">Counter offer</SelectItem>
              <SelectItem value="title_search">Title search</SelectItem>
              <SelectItem value="commitment">Commitment</SelectItem>
              <SelectItem value="closing_disclosure">
                Closing disclosure
              </SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
          <Button asChild disabled={busy} size="sm" className="gap-1.5">
            <label className="cursor-pointer">
              <Upload className="size-3.5" />
              {busy ? "Uploading..." : "Upload"}
              <Input
                type="file"
                className="hidden"
                onChange={onUpload}
                disabled={busy}
              />
            </label>
          </Button>
        </div>
      }
    >
      {error && (
        <p className="mb-4 rounded-md border border-[#b94f58]/30 bg-[#fdecee] px-3 py-2 text-sm text-[#8a3942]">
          {error}
        </p>
      )}

      {documents.length === 0 ? (
        <EmptyHint
          icon={<Upload className="size-4" />}
          title="No documents uploaded"
          body="Pick a type and upload the file — extraction runs on its own. One is enough to start reconciling; add more to unlock cross-document checks."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {documents.map((d) => (
            <DocumentRow
              key={d._id}
              documentId={d._id as Id<"documents">}
              title={d.title}
              docType={d.docType}
              sizeBytes={d.sizeBytes}
              uploadedAt={d.uploadedAt}
            />
          ))}
        </ul>
      )}
    </SectionShell>
  );
}

function DocumentRow({
  documentId,
  title,
  docType,
  sizeBytes,
  uploadedAt,
}: {
  documentId: Id<"documents">;
  title?: string;
  docType: string;
  sizeBytes?: number;
  uploadedAt: number;
}) {
  const ext = useQuery(
    convexQuery(api.extractions.getForDocument, { documentId }),
  );
  const runExtraction = useConvexMutation(api.extractions.run);
  const deleteDocument = useConvexMutation(api.files.deleteDocument);
  const openPreview = useDocumentPreview();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onExtract = async () => {
    setBusy(true);
    setErr(null);
    try {
      await runExtraction({ documentId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: `Delete "${title ?? docType}"?`,
      description:
        "Its extraction is removed too. Any inbound email this document came in on will drop back to the triage queue.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setDeleting(true);
    setErr(null);
    try {
      await deleteDocument({ documentId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };

  const status = ext.data?.status;
  const startedAt = ext.data?.startedAt as number | undefined;
  // Anthropic typically finishes in <30 s; consider anything older than
  // 90 s without a state change "stuck" so the user has a way out.
  const STUCK_AFTER_MS = 90_000;
  const isStale =
    (status === "running" || status === "pending") &&
    !!startedAt &&
    Date.now() - startedAt > STUCK_AFTER_MS;

  const label =
    status === "succeeded"
      ? "Re-extract"
      : isStale
        ? "Cancel & retry"
        : status === "running" || status === "pending"
          ? "Extracting..."
          : status === "failed"
            ? "Retry"
            : "Extract";

  // Derive a 4-stage "stage tracker" so users see the full pipeline live:
  // upload → extracting → reconciling → ready. The "reconciling" stage is
  // synthetic — auto-reconcile fires on extraction.success but completes in
  // ~1s, so we show it briefly using a time-since-completion heuristic.
  const completedAt = ext.data?.completedAt as number | undefined;
  const justCompleted =
    status === "succeeded" && !!completedAt && Date.now() - completedAt < 2000;
  const activeStage:
    | "uploaded"
    | "extracting"
    | "reconciling"
    | "ready"
    | "failed" =
    status === "failed"
      ? "failed"
      : !status
        ? "uploaded"
        : status === "succeeded" && justCompleted
          ? "reconciling"
          : status === "succeeded"
            ? "ready"
            : "extracting";

  const friendly =
    activeStage === "uploaded"
      ? "Just uploaded"
      : activeStage === "extracting"
        ? isStale
          ? "Stuck — try again"
          : "Reading the document..."
        : activeStage === "reconciling"
          ? "Cross-checking against other docs..."
          : activeStage === "ready"
            ? "Ready"
            : "Extraction failed";

  const isActive =
    activeStage === "extracting" || activeStage === "reconciling";

  return (
    <li
      id={`doc-${documentId}`}
      className="tk-doc-row relative scroll-mt-24 overflow-hidden rounded-xl border border-border/60 bg-card ring-1 ring-foreground/5 transition-shadow target:shadow-[0_0_0_3px_rgba(183,134,37,0.45)]"
    >
      {/* Shimmer sweeps across the row while a stage is in flight. */}
      {isActive && (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
          <div className="tk-shimmer-bar absolute inset-y-0 -left-1/3 w-1/3" />
        </div>
      )}

      <div className="relative z-10 flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div
            className={`grid size-9 shrink-0 place-items-center rounded-md border ${
              isActive
                ? "border-[#b78625]/40 bg-[#fdf6e8] text-[#7a5818]"
                : activeStage === "ready"
                  ? "border-[#3f7c64]/30 bg-[#e6f3ed] text-[#2f5d4b]"
                  : activeStage === "failed"
                    ? "border-[#b94f58]/30 bg-[#fdecee] text-[#8a3942]"
                    : "border-border bg-muted text-[#40233f]"
            }`}
          >
            {isActive ? (
              <Sparkles className="tk-soft-pulse size-4" />
            ) : activeStage === "ready" ? (
              <Check className="size-4" />
            ) : activeStage === "failed" ? (
              <CircleAlert className="size-4" />
            ) : (
              <FileText className="size-4" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-[#2e2430]">
              {title ?? docType}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="capitalize">{docType.replace(/_/g, " ")}</span>
              {sizeBytes !== undefined && (
                <>
                  <span>·</span>
                  <span className="font-numerals tabular-nums">
                    {(sizeBytes / 1024).toFixed(1)} KB
                  </span>
                </>
              )}
              <span>·</span>
              <span className="font-numerals tabular-nums">
                {new Date(uploadedAt).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            </div>

            <ProcessingTracker stage={activeStage} friendly={friendly} />

            {err && <div className="mt-1 text-xs text-[#8a3942]">{err}</div>}
            {ext.data?.errorMessage && (
              <div className="mt-1 text-xs text-[#8a3942]">
                {ext.data.errorMessage}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => openPreview?.(documentId)}
            disabled={!openPreview}
            className="gap-1.5"
            aria-label="Preview document"
            title="Preview document"
          >
            <Eye className="size-3.5" />
            Preview
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onExtract}
            disabled={
              busy ||
              deleting ||
              ((status === "running" || status === "pending") && !isStale)
            }
            className="gap-1.5"
          >
            <Sparkles className="size-3.5" />
            {label}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onDelete}
            disabled={busy || deleting}
            className="gap-1.5 text-[#8a3942] hover:bg-[#fdecee] hover:text-[#8a3942]"
            aria-label="Delete document"
            title="Delete document"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      <ExtractionTrailRow
        extractionId={ext.data?._id as Id<"documentExtractions"> | undefined}
        active={isActive}
      />
    </li>
  );
}

function ExtractionTrailRow({
  extractionId,
  active,
}: {
  extractionId: Id<"documentExtractions"> | undefined;
  active: boolean;
}) {
  const [open, setOpen] = useState(active);

  // Auto-expand the trail while extraction is running so the trail is
  // visible without a click; auto-collapse once it settles.
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  const events = useQuery({
    ...convexQuery(
      api.extractionEvents.listForExtraction,
      extractionId ? { extractionId } : "skip",
    ),
    enabled: !!extractionId && open,
  });

  if (!extractionId) return null;
  const rows = (events.data ?? []) as ReadonlyArray<{
    _id: string;
    seq: number;
    kind: "phase" | "observation" | "warning" | "error" | "done";
    label: string;
    detail?: string;
    createdAt: number;
  }>;

  return (
    <div className="relative z-10 border-t border-border/40 bg-muted/20 px-4 py-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-[#7a5818] transition hover:bg-[#fdf6e8]"
      >
        <Sparkles className="size-3" />
        {open ? "Hide thinking trail" : "Show thinking trail"}
        {rows.length > 0 && !open && (
          <span className="ml-1 text-muted-foreground">· {rows.length} steps</span>
        )}
      </button>
      {open && (
        <ol className="mt-2 flex flex-col gap-1.5">
          {rows.length === 0 && (
            <li className="text-muted-foreground italic">
              {active ? "Watching the model work…" : "No trail recorded for this run."}
            </li>
          )}
          {rows.map((e) => {
            const tone =
              e.kind === "error"
                ? "border-[#b94f58]/40 bg-[#fdecee] text-[#8a3942]"
                : e.kind === "warning"
                  ? "border-[#c9652e]/40 bg-[#fde9dc] text-[#7a3d18]"
                  : e.kind === "done"
                    ? "border-[#3f7c64]/40 bg-[#e6f3ed] text-[#2f5d4b]"
                    : e.kind === "observation"
                      ? "border-border/60 bg-card text-foreground"
                      : "border-[#b78625]/30 bg-[#fdf6e8] text-[#7a5818]";
            return (
              <li
                key={e._id}
                className={`relative flex flex-col rounded-md border px-2.5 py-1.5 ${tone}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{e.label}</span>
                  <span className="font-numerals shrink-0 text-[10px] tabular-nums text-muted-foreground">
                    {new Date(e.createdAt).toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                </div>
                {e.detail && (
                  <span className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                    {e.detail}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function ProcessingTracker({
  stage,
  friendly,
}: {
  stage: "uploaded" | "extracting" | "reconciling" | "ready" | "failed";
  friendly: string;
}) {
  const STAGES: ReadonlyArray<{
    key: "uploaded" | "extracting" | "reconciling" | "ready";
    label: string;
  }> = [
    { key: "uploaded", label: "Uploaded" },
    { key: "extracting", label: "Reading" },
    { key: "reconciling", label: "Cross-checking" },
    { key: "ready", label: "Ready" },
  ];
  const currentIndex =
    stage === "failed" ? 1 : STAGES.findIndex((s) => s.key === stage);

  return (
    <div className="mt-2 flex items-center gap-2">
      <div className="flex items-center gap-1">
        {STAGES.map((s, i) => {
          const done = stage !== "failed" && i < currentIndex;
          const active =
            stage !== "failed" && i === currentIndex && stage !== "ready";
          const ready = stage === "ready";
          return (
            <span
              key={s.key}
              aria-label={s.label}
              className={`inline-block h-1 rounded-full transition-all duration-500 ${
                ready || done
                  ? "w-5 bg-[#3f7c64]"
                  : active
                    ? "tk-soft-pulse w-7 bg-[#b78625]"
                    : stage === "failed" && i <= 1
                      ? "w-5 bg-[#b94f58]"
                      : "w-3 bg-border"
              }`}
            />
          );
        })}
      </div>
      <span
        className={`text-xs ${
          stage === "ready"
            ? "text-[#2f5d4b]"
            : stage === "failed"
              ? "text-[#8a3942]"
              : stage === "extracting" || stage === "reconciling"
                ? "text-[#7a5818]"
                : "text-muted-foreground"
        }`}
      >
        {friendly}
        {(stage === "extracting" || stage === "reconciling") && (
          <span className="ml-0.5 inline-flex gap-0.5">
            <span className="tk-dot inline-block">.</span>
            <span className="tk-dot inline-block" data-i="1">
              .
            </span>
            <span className="tk-dot inline-block" data-i="2">
              .
            </span>
          </span>
        )}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// LiveActivityRail — file-level, ambient view of the cascade as it runs.
// Two sources:
//   1. In-flight: documentExtractions in pending/running state. Yellow,
//      animated, one chip per doc.
//   2. Recently settled: system audit events from the cascade in the last
//      90s — extraction.succeeded/failed, reconciliation.run, county
//      snapshot stored. Green, with relative-time updates each second.
// Renders nothing when both sources are empty so the layout doesn't
// reserve space for the rail when the file is idle.
// ─────────────────────────────────────────────────────────────────────

const RAIL_RECENT_MS = 90_000;

function pickRailSummary(
  e: AuditEvent,
): { tone: "ok" | "warn"; label: string; sub?: string } | null {
  const md = (e.metadata ?? {}) as Record<string, unknown>;
  switch (e.action) {
    case "extraction.succeeded":
      return { tone: "ok", label: "Document read" };
    case "extraction.failed":
      return { tone: "warn", label: "Extraction failed" };
    case "reconciliation.run": {
      const counts = (md.bySeverity ?? {}) as {
        block?: number;
        warn?: number;
        info?: number;
      };
      const blockers = counts.block ?? 0;
      const warns = counts.warn ?? 0;
      const total = blockers + warns + (counts.info ?? 0);
      if (total === 0) {
        return { tone: "ok", label: "All clear" };
      }
      const partsBits: string[] = [];
      if (blockers > 0)
        partsBits.push(`${blockers} blocker${blockers === 1 ? "" : "s"}`);
      if (warns > 0)
        partsBits.push(`${warns} warning${warns === 1 ? "" : "s"}`);
      return {
        tone: blockers > 0 ? "warn" : "ok",
        label: "Cross-checked",
        sub: partsBits.join(" · ") || `${total} note${total === 1 ? "" : "s"}`,
      };
    }
    case "county_connect.snapshot.stored":
      return { tone: "ok", label: "Pulled county records" };
    default:
      return null;
  }
}

function LiveActivityRail({
  documents,
  extractions,
  events,
}: {
  documents: ReadonlyArray<Doc<"documents">>;
  extractions: ReadonlyArray<ExtractionLite>;
  events: ReadonlyArray<AuditEvent>;
}) {
  const extractionStatusByDoc = useMemo(() => {
    const m = new Map<string, "pending" | "running" | "succeeded" | "failed">();
    for (const e of extractions) {
      m.set(
        e.documentId,
        e.status as "pending" | "running" | "succeeded" | "failed",
      );
    }
    return m;
  }, [extractions]);

  const inFlight = useMemo(
    () =>
      documents.filter((d) => {
        const s = extractionStatusByDoc.get(d._id);
        return s === "pending" || s === "running";
      }),
    [documents, extractionStatusByDoc],
  );

  const [now, setNow] = useState(() => Date.now());

  // Settled chips: only system-actor events of cascade kinds, freshly enough
  // to be interesting. Filtered against `now` so each tick ages stale ones
  // off without remounting the component.
  const recent = useMemo(() => {
    const out: Array<{
      _id: string;
      occurredAt: number;
      summary: NonNullable<ReturnType<typeof pickRailSummary>>;
    }> = [];
    for (const e of events) {
      if (now - e.occurredAt >= RAIL_RECENT_MS) break; // events are desc by time
      if (e.actor?.kind !== "system") continue;
      const summary = pickRailSummary(e);
      if (!summary) continue;
      out.push({ _id: e._id, occurredAt: e.occurredAt, summary });
      if (out.length >= 4) break;
    }
    return out;
  }, [events, now]);

  const hasContent = inFlight.length > 0 || recent.length > 0;

  // Tick only while the rail has anything to show — no need to re-render
  // every second on idle files.
  useEffect(() => {
    if (!hasContent) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasContent]);

  if (!hasContent) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {inFlight.map((d) => (
        <RailChip
          key={`flight-${d._id}`}
          tone="busy"
          icon={<Sparkles className="tk-soft-pulse size-3.5" />}
          label="Reading"
          sub={d.title ?? d.docType.replace(/_/g, " ")}
          showDots
        />
      ))}
      {recent.map((r) => (
        <RailChip
          key={`recent-${r._id}`}
          tone={r.summary.tone}
          icon={
            r.summary.tone === "warn" ? (
              <CircleAlert className="size-3.5" />
            ) : (
              <Check className="size-3.5" />
            )
          }
          label={r.summary.label}
          sub={r.summary.sub}
          time={formatRelative(r.occurredAt)}
        />
      ))}
    </div>
  );
}

function RailChip({
  tone,
  icon,
  label,
  sub,
  time,
  showDots,
}: {
  tone: "busy" | "ok" | "warn";
  icon: React.ReactNode;
  label: string;
  sub?: string;
  time?: string;
  showDots?: boolean;
}) {
  const palette =
    tone === "busy"
      ? "bg-[#fdf6e8] text-[#7a5818] ring-[#b78625]/30"
      : tone === "warn"
        ? "bg-[#fdecee] text-[#8a3942] ring-[#b94f58]/30"
        : "bg-[#e6f3ed] text-[#2f5d4b] ring-[#3f7c64]/30";
  return (
    <span
      className={`inline-flex max-w-[24rem] items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${palette}`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">
        {label}
        {sub && <span className="font-normal opacity-80"> · {sub}</span>}
      </span>
      {showDots && (
        <span className="inline-flex shrink-0 gap-0.5 leading-none">
          <span className="tk-dot inline-block">.</span>
          <span className="tk-dot inline-block" data-i="1">
            .
          </span>
          <span className="tk-dot inline-block" data-i="2">
            .
          </span>
        </span>
      )}
      {time && (
        <span className="font-numerals shrink-0 tabular-nums opacity-70">
          {time}
        </span>
      )}
    </span>
  );
}

type FindingDoc = ReadonlyArray<{
  _id: string;
  title?: string;
  docType: string;
  uploadedAt: number;
  contentType?: string;
}>;

type Finding = {
  _id: string;
  findingType: string;
  severity: "info" | "warn" | "block";
  message: string;
  involvedDocumentIds: ReadonlyArray<string>;
  involvedFields: ReadonlyArray<string>;
  rawDetail: unknown;
  status: "open" | "acknowledged" | "resolved" | "dismissed";
  resolvedDocumentId?: string;
  resolvedValue?: unknown;
};

const DocumentPreviewContext = createContext<
  ((documentId: Id<"documents">) => void) | null
>(null);

function useDocumentPreview() {
  return useContext(DocumentPreviewContext);
}

function DocumentPreviewSheet({
  documentId,
  documents,
  onOpenChange,
}: {
  documentId: Id<"documents"> | null;
  documents: FindingDoc;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Drawer open={!!documentId} onOpenChange={onOpenChange} direction="right">
      <DrawerContent
        className={
          // PDFs are dense — give the drawer most of the viewport on desktop.
          "flex h-full w-full flex-col border-l border-border/70 bg-card p-0 text-foreground shadow-2xl ring-1 ring-foreground/5 " +
          "data-[vaul-drawer-direction=right]:w-full " +
          "data-[vaul-drawer-direction=right]:sm:max-w-none " +
          "data-[vaul-drawer-direction=right]:sm:w-[92vw] " +
          "data-[vaul-drawer-direction=right]:lg:w-[85vw] " +
          "data-[vaul-drawer-direction=right]:xl:w-[78vw] " +
          "data-[vaul-drawer-direction=right]:2xl:w-[72vw]"
        }
      >
        {documentId ? (
          <DocumentPreviewBody documentId={documentId} documents={documents} />
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}

function DocumentPreviewBody({
  documentId,
  documents,
}: {
  documentId: Id<"documents">;
  documents: FindingDoc;
}) {
  const url = useQuery(convexQuery(api.files.documentUrl, { documentId }));
  const doc = documents.find((d) => d._id === documentId);
  const title = doc?.title ?? doc?.docType ?? "Document";
  const docType = doc?.docType?.replace(/_/g, " ") ?? null;
  const isImage = (doc?.contentType ?? "").startsWith("image/");
  const sizeKb =
    doc && "sizeBytes" in doc && typeof doc.sizeBytes === "number"
      ? `${(doc.sizeBytes / 1024).toFixed(1)} KB`
      : null;
  const uploaded = doc?.uploadedAt
    ? new Date(doc.uploadedAt).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  return (
    <>
      <DrawerHeader className="relative flex flex-row items-start justify-between gap-4 overflow-hidden border-b border-border/70 px-6 pt-5 pb-4">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 paper-grain opacity-60"
        />
        <div className="relative flex min-w-0 flex-1 items-start gap-3">
          <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-[#40233f]/15 bg-[#fdf6e8] text-[#40233f]">
            <FileText className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#b78625]">
              <Eye className="size-3.5" />
              Document preview
            </div>
            <DrawerTitle asChild>
              <h2 className="mt-0.5 truncate font-display text-xl font-semibold tracking-tight text-[#40233f]">
                {title}
              </h2>
            </DrawerTitle>
            <DrawerDescription asChild>
              <div className="font-numerals mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums">
                {docType && <span className="capitalize">{docType}</span>}
                {sizeKb && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{sizeKb}</span>
                  </>
                )}
                {uploaded && (
                  <>
                    <span aria-hidden>·</span>
                    <span>uploaded {uploaded}</span>
                  </>
                )}
                {url.data && (
                  <>
                    <span aria-hidden>·</span>
                    <a
                      href={url.data}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[#40233f] underline-offset-2 transition hover:text-[#593157] hover:underline"
                    >
                      <ExternalLink className="size-3" />
                      Open in new tab
                    </a>
                  </>
                )}
              </div>
            </DrawerDescription>
          </div>
        </div>
        <DrawerClose asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close preview"
            className="relative shrink-0 text-muted-foreground hover:bg-[#fdf6e8] hover:text-[#40233f]"
          >
            <X className="size-4" />
          </Button>
        </DrawerClose>
      </DrawerHeader>
      <div className="relative flex-1 overflow-hidden bg-[#f3ece1]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 paper-grain opacity-30"
        />
        {url.isLoading || !url.data ? (
          <div className="absolute inset-0 grid place-items-center">
            <div className="flex items-center gap-2 rounded-full bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm ring-1 ring-foreground/5">
              <Sparkles className="tk-soft-pulse size-3.5 text-[#b78625]" />
              Loading preview
              <span className="inline-flex gap-0.5 leading-none">
                <span className="tk-dot inline-block">.</span>
                <span className="tk-dot inline-block" data-i="1">
                  .
                </span>
                <span className="tk-dot inline-block" data-i="2">
                  .
                </span>
              </span>
            </div>
          </div>
        ) : isImage ? (
          <div className="absolute inset-0 overflow-auto p-4 sm:p-6">
            <img
              src={url.data}
              alt={title}
              className="mx-auto h-auto max-w-full rounded-md bg-white shadow-md ring-1 ring-foreground/10"
            />
          </div>
        ) : (
          <div className="absolute inset-0 p-3 sm:p-4">
            <iframe
              src={url.data}
              title={title}
              className="size-full rounded-md border-0 bg-white shadow-md ring-1 ring-foreground/10"
            />
          </div>
        )}
      </div>
    </>
  );
}

type ExtractionLite = {
  documentId: string;
  status: string;
  payload?: unknown;
};

type ExtractionView = {
  documentKind?: string;
  parties?: Array<{ role?: string; legalName?: string; capacity?: string }>;
  financial?: {
    purchasePrice?: number;
    earnestMoney?: { amount?: number; refundable?: boolean };
  } | null;
  dates?: {
    closingDate?: string;
    financingApprovalDays?: number;
  } | null;
  titleCompany?: { name?: string; selectedBy?: string } | null;
};

type FactSeverity = "info" | "warn" | "block";

type FactStatus = "agreed" | "disagreed" | "single-source" | "resolved";

type FactEvidenceRow = {
  documentId: string;
  documentKind?: string;
  uploadedAt: number;
  display: string;
  raw: unknown;
  confidence?: number;
};

type Fact = {
  id: string;
  label: string;
  status: FactStatus;
  agreedDisplay?: string;
  evidence: FactEvidenceRow[];
  finding?: Finding;
  severity?: FactSeverity;
  isAmendment: boolean;
  confidenceFieldPath: string | null;
};

function PublicRecordsPanel({
  fileId,
  hasProperty,
}: {
  fileId: Id<"files">;
  hasProperty: boolean;
}) {
  const snapshotQ = useQuery(
    convexQuery(api.countyConnect.getSnapshotForFile, { fileId }),
  );
  const runForFile = useAction(api.countyConnect.runForFile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPull = async () => {
    setBusy(true);
    setError(null);
    try {
      await runForFile({ fileId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.replace(/^.*ConvexError:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const snap = snapshotQ.data ?? null;
  const fetchedLabel = snap ? formatRelative(snap.fetchedAt) : null;
  const openLienCount = snap ? countOpenLiens(snap.documents) : 0;

  return (
    <SectionShell
      id="step-public-records"
      icon={<Building2 className="size-4" />}
      eyebrow="Public records"
      title="County data"
      description="Owner-of-record, recorded liens, and tax data pulled directly from public-records sources. Re-run after the property address changes."
      actions={
        <div className="flex items-center gap-2">
          {snap && (
            <span className="text-xs text-muted-foreground">
              {snap.provider === "mock" ? "Demo data · " : ""}
              {fetchedLabel}
            </span>
          )}
          <Button
            onClick={onPull}
            disabled={busy || !hasProperty}
            size="sm"
            variant={snap ? "outline" : "default"}
            className="gap-1.5"
            title={
              hasProperty
                ? "Pull fresh county records and re-run reconciliation"
                : "Set the property address first"
            }
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : snap ? (
              <RefreshCw className="size-3.5" />
            ) : (
              <Database className="size-3.5" />
            )}
            {busy
              ? "Pulling..."
              : snap
                ? "Refresh"
                : "Pull county records & reconcile"}
          </Button>
        </div>
      }
    >
      {!hasProperty ? (
        <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
          Set the property address to enable county-records lookups.
        </div>
      ) : error ? (
        <div className="rounded-md border border-[#b94f58]/30 bg-[#fdecee] px-3 py-2 text-sm text-[#8a3942]">
          {error}
        </div>
      ) : !snap ? (
        <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
          No public-records snapshot yet. Click <strong>Pull county records</strong>{" "}
          to fetch property profile, recorded documents, and tax data — then
          reconcile against the file.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {snap.status !== "ok" && snap.errorMessage && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <strong>Partial data:</strong> {snap.errorMessage}
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <RecordCell
              label="Owner of record"
              primary={snap.property?.owner.name ?? "—"}
              secondary={
                snap.property?.lastSale?.date
                  ? `Last sale ${snap.property.lastSale.date}${
                      snap.property.lastSale.price !== null
                        ? ` · $${snap.property.lastSale.price.toLocaleString()}`
                        : ""
                    }`
                  : null
              }
            />
            <RecordCell
              label="Recorded liens (open)"
              primary={String(openLienCount)}
              secondary={
                snap.documents.length > 0
                  ? `${snap.documents.length} total documents on record`
                  : "No documents on record"
              }
            />
            <RecordCell
              label="Property tax"
              primary={
                snap.tax?.taxAmount !== null && snap.tax?.taxAmount !== undefined
                  ? `$${snap.tax.taxAmount.toLocaleString()}`
                  : "—"
              }
              secondary={
                snap.tax?.taxYear
                  ? `Tax year ${snap.tax.taxYear}${
                      snap.tax.assessedValue !== null
                        ? ` · Assessed $${snap.tax.assessedValue.toLocaleString()}`
                        : ""
                    }`
                  : null
              }
            />
          </div>
          {snap.documents.length > 0 && (
            <details className="rounded-md border bg-card">
              <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-foreground">
                Recorded documents ({snap.documents.length})
              </summary>
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Recorded</th>
                    <th className="px-3 py-2">Doc #</th>
                    <th className="px-3 py-2">Grantor</th>
                    <th className="px-3 py-2">Grantee</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {snap.documents.map((d, i) => (
                    <tr key={`${d.documentNumber ?? i}-${d.recordingDate ?? i}`}>
                      <td className="px-3 py-2">{d.documentType}</td>
                      <td className="px-3 py-2">{d.recordingDate ?? "—"}</td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {d.documentNumber ?? d.bookPage ?? "—"}
                      </td>
                      <td className="px-3 py-2">{d.grantor ?? "—"}</td>
                      <td className="px-3 py-2">{d.grantee ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {d.amount !== null
                          ? `$${d.amount.toLocaleString()}`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </div>
      )}
    </SectionShell>
  );
}

function RecordCell({
  label,
  primary,
  secondary,
}: {
  label: string;
  primary: string;
  secondary: string | null;
}) {
  return (
    <div className="rounded-md border bg-card px-3 py-2.5">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-sm font-medium text-foreground">
        {primary}
      </div>
      {secondary && (
        <div className="mt-0.5 text-xs text-muted-foreground">{secondary}</div>
      )}
    </div>
  );
}

// Counts mortgage/lien-style documents that don't have a corresponding
// release recorded later. Strict naming match for v1 — a smarter matcher
// (link by grantor identity + amount) lands when the comparator goes in.
function countOpenLiens(
  documents: ReadonlyArray<{
    documentType: string;
    recordingDate: string | null;
  }>,
): number {
  const releases = documents.filter((d) =>
    /release|satisfaction|reconveyance/i.test(d.documentType),
  );
  const liens = documents.filter((d) =>
    /mortgage|deed of trust|lien/i.test(d.documentType),
  );
  return Math.max(0, liens.length - releases.length);
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// The ordering reconciliation surfaces facts in: needs-attention first
// (block → warn → info), then settled (agreed / single-source / resolved).
const FACT_LAYOUT = [
  { id: "purchase_price", label: "Purchase price" },
  { id: "earnest_money", label: "Earnest money" },
  { id: "closing_date", label: "Closing date" },
  { id: "financing_window", label: "Financing window" },
  { id: "title_company", label: "Title company" },
] as const;

const FACTABLE_FINDING_TYPES = new Set([
  "price_mismatch",
  "price_amended",
  "title_company_change",
  "title_company_set",
  "earnest_money_refundability_change",
  "closing_date_mismatch",
  "financing_window_change",
  "party_name_mismatch",
]);

function ReconciliationPanel({
  fileId,
  documents,
  extractions,
  confidenceByDoc,
  findings,
  reconcileReady,
  missingPrereqs,
}: {
  fileId: Id<"files">;
  documents: FindingDoc;
  extractions: ReadonlyArray<ExtractionLite>;
  confidenceByDoc: Map<string, Record<string, number>>;
  findings: ReadonlyArray<Finding>;
  reconcileReady: boolean;
  missingPrereqs: { property: boolean; parties: boolean; docs: boolean };
}) {
  const reconcile = useConvexMutation(api.reconciliation.runForFile);
  const setStatus = useConvexMutation(api.reconciliation.setStatus);
  const resolveWith = useConvexMutation(api.reconciliation.resolveWith);
  const verify = useConvexMutation(api.reconciliation.verifyFinding);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeFilters, setActiveFilters] = useState<Set<FactSeverity>>(
    () => new Set(["block", "warn", "info"]),
  );

  const onReconcile = async () => {
    setBusy(true);
    setError(null);
    try {
      await reconcile({ fileId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onAck = async (
    findingId: Id<"reconciliationFindings">,
    next: "acknowledged" | "resolved" | "dismissed",
  ) => {
    try {
      await setStatus({ findingId, status: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onResolveWith = async (
    findingId: Id<"reconciliationFindings">,
    documentId: Id<"documents">,
    value: unknown,
  ) => {
    try {
      await resolveWith({ findingId, documentId, value });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onVerify = async (
    findingId: Id<"reconciliationFindings">,
    method:
      | "phone_call"
      | "independent"
      | "recording_search"
      | "payoff_on_file"
      | "in_person"
      | "other",
    note?: string,
  ) => {
    try {
      await verify({ findingId, method, note });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const { facts, otherFindings } = useMemo(
    () =>
      deriveFacts({
        documents,
        extractions,
        findings,
        confidenceByDoc,
      }),
    [documents, extractions, findings, confidenceByDoc],
  );

  const dismissedFindings = findings.filter((f) => f.status === "dismissed");

  const counts = useMemo(() => {
    const c = { block: 0, warn: 0, info: 0 };
    for (const f of facts) {
      if (f.status !== "disagreed") continue;
      if (f.severity) c[f.severity]++;
    }
    for (const f of otherFindings) {
      if (f.status === "open" || f.status === "acknowledged") c[f.severity]++;
    }
    return c;
  }, [facts, otherFindings]);

  const total = counts.block + counts.warn + counts.info;
  const reconciled = findings.length > 0 || facts.length > 0;
  const allClear = reconciled && total === 0;
  const done = allClear;

  const toggleFilter = (sev: FactSeverity) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(sev)) next.delete(sev);
      else next.add(sev);
      // Empty filter set is a footgun — treat it as "all on".
      if (next.size === 0) return new Set(["block", "warn", "info"]);
      return next;
    });
  };

  const settledFacts = facts.filter((f) => f.status !== "disagreed");
  const disagreedFacts = facts
    .filter((f) => f.status === "disagreed")
    .filter((f) => !f.severity || activeFilters.has(f.severity));

  const visibleOtherFindings = otherFindings
    .filter((f) => f.status === "open" || f.status === "acknowledged")
    .filter((f) => activeFilters.has(f.severity))
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

  const allFiltersOn = activeFilters.size === 3;

  return (
    <SectionShell
      id="step-reconcile"
      step={4}
      done={done}
      eyebrow="The reconciliation"
      title="Cross-document checks"
      description="Every fact lined up across every document. Green ticks are settled; conflicts wait for a pick. Re-runs automatically after each extraction."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <SeverityChip
            count={counts.block}
            severity="block"
            active={activeFilters.has("block")}
            onClick={() => toggleFilter("block")}
            disabled={total === 0}
          />
          <SeverityChip
            count={counts.warn}
            severity="warn"
            active={activeFilters.has("warn")}
            onClick={() => toggleFilter("warn")}
            disabled={total === 0}
          />
          <SeverityChip
            count={counts.info}
            severity="info"
            active={activeFilters.has("info")}
            onClick={() => toggleFilter("info")}
            disabled={total === 0}
          />
          <Button
            onClick={onReconcile}
            disabled={busy || !reconcileReady}
            className="gap-1.5"
            size="sm"
            title={
              reconcileReady
                ? "Run reconciliation now"
                : "Finish steps 1–3 first to make this useful"
            }
          >
            <Stamp className="size-3.5" />
            {busy ? "Running..." : reconciled ? "Re-run" : "Run reconcile"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {!reconcileReady && (
          <PrereqBanner
            property={missingPrereqs.property}
            parties={missingPrereqs.parties}
            docs={missingPrereqs.docs}
          />
        )}

        {error && (
          <p className="rounded-md border border-[#b94f58]/30 bg-[#fdecee] px-3 py-2 text-sm text-[#8a3942]">
            {error}
          </p>
        )}

        {!reconciled ? (
          <EmptyHint
            icon={<Stamp className="size-4" />}
            title="Waiting on the first extraction"
            body={
              reconcileReady
                ? "Reconciliation will start automatically — or click Run reconcile to kick it now."
                : "Reconciliation runs on its own as soon as a document finishes extracting. Finish the steps above to unlock it."
            }
          />
        ) : (
          <>
            {allClear && facts.length > 0 && (
              <div className="flex items-start gap-3 rounded-xl border border-[#3f7c64]/30 bg-[#e6f3ed] px-4 py-3 text-sm text-[#2f5d4b] ring-1 ring-[#3f7c64]/20 ring-inset">
                <Check className="mt-0.5 size-4 shrink-0" />
                <div>
                  <div className="font-medium">All clear.</div>
                  <div className="text-xs leading-snug text-[#2f5d4b]/80">
                    Every cross-document fact agrees. Closing docs may proceed
                    from the reconciled set below.
                  </div>
                </div>
              </div>
            )}

            {disagreedFacts.length > 0 && (
              <section className="flex flex-col gap-2">
                <SectionLabel>Needs attention</SectionLabel>
                <div className="flex flex-col gap-2.5">
                  {disagreedFacts.map((fact) => (
                    <DisagreedFactCard
                      key={fact.id}
                      fact={fact}
                      documents={documents}
                      onSetStatus={onAck}
                      onResolveWith={onResolveWith}
                    />
                  ))}
                </div>
              </section>
            )}

            {visibleOtherFindings.length > 0 && (
              <section className="flex flex-col gap-2">
                <SectionLabel>Other issues</SectionLabel>
                <div className="flex flex-col gap-2">
                  {visibleOtherFindings.map((f) => (
                    <OtherIssueCard
                      key={f._id}
                      finding={f}
                      documents={documents}
                      onSetStatus={onAck}
                      onVerify={onVerify}
                    />
                  ))}
                </div>
              </section>
            )}

            {!allFiltersOn &&
              disagreedFacts.length === 0 &&
              visibleOtherFindings.length === 0 &&
              total > 0 && (
                <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  Filtered out — no items match the selected severities.
                </p>
              )}

            {settledFacts.length > 0 && (
              <section className="flex flex-col gap-2">
                <SectionLabel muted>Settled</SectionLabel>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {settledFacts.map((fact) => (
                    <SettledFactRow
                      key={fact.id}
                      fact={fact}
                      documents={documents}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {dismissedFindings.length > 0 && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium hover:text-[#40233f]">
              {dismissedFindings.length} closed{" "}
              {dismissedFindings.length === 1 ? "issue" : "issues"}
            </summary>
            <ul className="mt-2 flex flex-col gap-1.5">
              {dismissedFindings.map((f) => (
                <li
                  key={f._id}
                  className="rounded-md border border-border/60 bg-muted/30 p-2.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {f.status}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {f.findingType.replace(/_/g, " ")}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[12px] text-foreground/80">
                    {f.message}
                  </div>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </SectionShell>
  );
}

function severityRank(s: FactSeverity): number {
  return s === "block" ? 3 : s === "warn" ? 2 : 1;
}

function SectionLabel({
  children,
  muted,
}: {
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <h3
      className={`flex items-center gap-2 text-xs font-medium ${
        muted ? "text-muted-foreground/70" : "text-muted-foreground"
      }`}
    >
      <span>{children}</span>
      <span aria-hidden className="h-px flex-1 bg-border/70" />
    </h3>
  );
}

function deriveFacts(args: {
  documents: FindingDoc;
  extractions: ReadonlyArray<ExtractionLite>;
  findings: ReadonlyArray<Finding>;
  confidenceByDoc: Map<string, Record<string, number>>;
}): { facts: Fact[]; otherFindings: Finding[] } {
  const { documents, extractions, findings, confidenceByDoc } = args;
  const docById = new Map<string, FindingDoc[number]>();
  for (const d of documents) docById.set(d._id, d);

  const views = new Map<string, ExtractionView>();
  for (const e of extractions) {
    if (e.status === "succeeded" && e.payload) {
      views.set(e.documentId, e.payload as ExtractionView);
    }
  }

  const findingByType = (...types: string[]): Finding | undefined =>
    findings.find(
      (f) => types.includes(f.findingType) && f.status !== "dismissed",
    );

  const otherFindings = findings.filter(
    (f) => !FACTABLE_FINDING_TYPES.has(f.findingType),
  );

  const facts: Fact[] = [];

  // Single-value scalar facts (price, dates, financing window, title company).
  facts.push(
    buildFact({
      id: "purchase_price",
      label: "Purchase price",
      confidenceFieldPath: "financial.purchasePrice",
      pickRaw: (v) => v.financial?.purchasePrice,
      format: (raw) =>
        typeof raw === "number" ? `$${raw.toLocaleString()}` : "—",
      finding: findingByType("price_mismatch", "price_amended"),
      isAmendment: !!findingByType("price_amended"),
      compareKey: (raw) =>
        typeof raw === "number" ? String(raw) : JSON.stringify(raw),
    }),
    buildFact({
      id: "closing_date",
      label: "Closing date",
      confidenceFieldPath: "dates.closingDate",
      pickRaw: (v) => v.dates?.closingDate,
      format: (raw) => (typeof raw === "string" ? raw : "—"),
      finding: findingByType("closing_date_mismatch"),
      isAmendment: false,
      compareKey: (raw) => (typeof raw === "string" ? raw.trim() : ""),
    }),
    buildFact({
      id: "financing_window",
      label: "Financing window",
      confidenceFieldPath: "dates.financingApprovalDays",
      pickRaw: (v) => v.dates?.financingApprovalDays,
      format: (raw) => (typeof raw === "number" ? `${raw} days` : "—"),
      finding: findingByType("financing_window_change"),
      isAmendment: !!findingByType("financing_window_change"),
      compareKey: (raw) =>
        typeof raw === "number" ? String(raw) : JSON.stringify(raw),
    }),
    buildFact({
      id: "title_company",
      label: "Title company",
      confidenceFieldPath: "titleCompany.name",
      pickRaw: (v) => v.titleCompany ?? undefined,
      format: (raw) => {
        const tc = raw as { name?: string; selectedBy?: string } | undefined;
        if (!tc?.name) return "—";
        return tc.selectedBy ? `${tc.name} · ${tc.selectedBy}` : tc.name;
      },
      finding: findingByType("title_company_change", "title_company_set"),
      isAmendment: !!findingByType("title_company_change"),
      compareKey: (raw) => {
        const tc = raw as { name?: string } | undefined;
        return (tc?.name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
      },
    }),
    buildFact({
      id: "earnest_money",
      label: "Earnest money",
      confidenceFieldPath: "financial.earnestMoney.refundable",
      pickRaw: (v) => v.financial?.earnestMoney,
      format: (raw) => {
        const em = raw as { amount?: number; refundable?: boolean } | undefined;
        if (!em) return "—";
        const refund =
          em.refundable === true
            ? "refundable"
            : em.refundable === false
              ? "non-refundable"
              : null;
        const amt =
          typeof em.amount === "number"
            ? `$${em.amount.toLocaleString()}`
            : null;
        return [amt, refund].filter(Boolean).join(" · ") || "—";
      },
      finding: findingByType("earnest_money_refundability_change"),
      isAmendment: !!findingByType("earnest_money_refundability_change"),
      compareKey: (raw) => {
        const em = raw as { amount?: number; refundable?: boolean } | undefined;
        return `${em?.refundable ?? "?"}|${em?.amount ?? "?"}`;
      },
    }),
  );

  function buildFact(args: {
    id: string;
    label: string;
    confidenceFieldPath: string;
    pickRaw: (v: ExtractionView) => unknown;
    format: (raw: unknown) => string;
    compareKey: (raw: unknown) => string;
    finding?: Finding;
    isAmendment: boolean;
  }): Fact {
    const evidence: FactEvidenceRow[] = [];
    for (const [docId, view] of views) {
      const raw = args.pickRaw(view);
      if (raw === undefined || raw === null) continue;
      // earnestMoney can be {} — drop empties.
      if (
        typeof raw === "object" &&
        raw !== null &&
        Object.values(raw).every((v) => v === undefined)
      ) {
        continue;
      }
      const doc = docById.get(docId);
      evidence.push({
        documentId: docId,
        documentKind: view.documentKind,
        uploadedAt: doc?.uploadedAt ?? 0,
        display: args.format(raw),
        raw,
        confidence: lookupConfidence(
          confidenceByDoc.get(docId),
          args.confidenceFieldPath,
        ),
      });
    }
    evidence.sort((a, b) => a.uploadedAt - b.uploadedAt);

    const finding = args.finding;
    let status: FactStatus;
    let agreedDisplay: string | undefined;

    if (finding?.status === "resolved") {
      status = "resolved";
      agreedDisplay =
        finding.resolvedValue !== undefined
          ? args.format(finding.resolvedValue)
          : undefined;
    } else if (evidence.length === 0) {
      status = "single-source";
    } else if (evidence.length === 1) {
      status = "single-source";
      agreedDisplay = evidence[0].display;
    } else {
      const distinct = new Set(evidence.map((e) => args.compareKey(e.raw)));
      if (distinct.size <= 1) {
        status = "agreed";
        agreedDisplay = evidence[0].display;
      } else {
        status = "disagreed";
      }
    }

    return {
      id: args.id,
      label: args.label,
      status,
      agreedDisplay,
      evidence,
      finding,
      severity: finding?.severity,
      isAmendment: args.isAmendment,
      confidenceFieldPath: args.confidenceFieldPath,
    };
  }

  // Empty facts (no evidence at all) are not interesting — drop them.
  const filtered = facts.filter((f) => f.evidence.length > 0);

  // Order: disagreed first (block → warn → info), then agreed/resolved/single-source
  // in the canonical layout order.
  const layoutIndex = new Map<string, number>(
    FACT_LAYOUT.map((l, i) => [l.id, i]),
  );
  filtered.sort((a, b) => {
    const aDis = a.status === "disagreed" ? 0 : 1;
    const bDis = b.status === "disagreed" ? 0 : 1;
    if (aDis !== bDis) return aDis - bDis;
    if (a.status === "disagreed" && b.status === "disagreed") {
      return (
        severityRank(b.severity ?? "info") - severityRank(a.severity ?? "info")
      );
    }
    return (layoutIndex.get(a.id) ?? 99) - (layoutIndex.get(b.id) ?? 99);
  });

  return { facts: filtered, otherFindings };
}

function DisagreedFactCard({
  fact,
  documents,
  onSetStatus,
  onResolveWith,
}: {
  fact: Fact;
  documents: FindingDoc;
  onSetStatus: (
    findingId: Id<"reconciliationFindings">,
    status: "acknowledged" | "resolved" | "dismissed",
  ) => void;
  onResolveWith: (
    findingId: Id<"reconciliationFindings">,
    documentId: Id<"documents">,
    value: unknown,
  ) => void;
}) {
  const sev = fact.severity ?? "warn";
  const tone =
    sev === "block"
      ? {
          border: "border-[#b94f58]/40",
          bg: "bg-[#fdecee]/40",
          text: "text-[#8a3942]",
          chip: "bg-[#fdecee] text-[#8a3942]",
        }
      : sev === "warn"
        ? {
            border: "border-[#c9652e]/35",
            bg: "bg-[#fde9dc]/40",
            text: "text-[#7a3d18]",
            chip: "bg-[#fde9dc] text-[#7a3d18]",
          }
        : {
            border: "border-[#3f668f]/35",
            bg: "bg-[#e8f0f8]/50",
            text: "text-[#2c4a6b]",
            chip: "bg-[#e8f0f8] text-[#2c4a6b]",
          };

  const finding = fact.finding;
  const latestDocId = fact.evidence[fact.evidence.length - 1]?.documentId;

  return (
    <div
      className={`rounded-xl border ${tone.border} ${tone.bg} p-3.5 ring-1 ring-inset ${tone.border.replace("border", "ring")}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone.chip}`}
          >
            <span
              className={`size-1 rounded-full ${
                sev === "block"
                  ? "bg-[#b94f58]"
                  : sev === "warn"
                    ? "bg-[#c9652e]"
                    : "bg-[#3f668f]"
              }`}
            />
            {sev === "block" ? "Blocker" : sev === "warn" ? "Warning" : "Note"}
          </span>
          <span className={`text-sm font-semibold ${tone.text}`}>
            {fact.label}
          </span>
          {fact.isAmendment && (
            <span className="rounded-full bg-card px-1.5 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-border ring-inset">
              amended
            </span>
          )}
        </div>
        {finding && (
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() =>
                onSetStatus(
                  finding._id as Id<"reconciliationFindings">,
                  "acknowledged",
                )
              }
              className="rounded-full px-2 py-0.5 text-xs text-muted-foreground transition hover:bg-card hover:text-[#40233f]"
            >
              Acknowledge
            </button>
            <button
              type="button"
              onClick={() =>
                onSetStatus(
                  finding._id as Id<"reconciliationFindings">,
                  "dismissed",
                )
              }
              className="rounded-full px-2 py-0.5 text-xs text-muted-foreground transition hover:bg-card hover:text-[#40233f]"
            >
              Not relevant
            </button>
          </div>
        )}
      </div>

      {finding?.message && (
        <p className={`mt-1.5 text-sm ${tone.text}`}>{finding.message}</p>
      )}

      <FactEvidenceTable
        rows={fact.evidence}
        documents={documents}
        latestDocId={latestDocId}
        timeline={fact.isAmendment}
        onResolveWith={
          finding
            ? (documentId, value) =>
                onResolveWith(
                  finding._id as Id<"reconciliationFindings">,
                  documentId,
                  value,
                )
            : undefined
        }
      />

      {import.meta.env.DEV && finding?.rawDetail !== undefined && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-[#40233f]">
            Raw detail (debug)
          </summary>
          <pre className="mt-1 overflow-x-auto rounded bg-card/70 p-2 text-xs leading-tight text-foreground/70">
            {JSON.stringify(finding.rawDetail, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function FactEvidenceTable({
  rows,
  documents,
  latestDocId,
  timeline,
  onResolveWith,
}: {
  rows: FactEvidenceRow[];
  documents: FindingDoc;
  latestDocId?: string;
  timeline: boolean;
  onResolveWith?: (documentId: Id<"documents">, value: unknown) => void;
}) {
  const openPreview = useDocumentPreview();
  return (
    <div className="mt-3 overflow-hidden rounded-md border border-current/15 bg-card/70">
      <ul className="divide-y divide-border/40">
        {rows.map((r, i) => {
          const doc = documents.find((d) => d._id === r.documentId);
          const label = doc?.title ?? doc?.docType ?? "(unknown)";
          const isLatest = r.documentId === latestDocId;
          const lowConfidence =
            r.confidence !== undefined && r.confidence < 0.7;
          return (
            <li
              key={`${r.documentId}-${i}`}
              className="flex flex-wrap items-center gap-3 px-3 py-2 text-xs"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {timeline && (
                  <span
                    aria-hidden
                    className={`grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${
                      isLatest
                        ? "bg-[#40233f] text-[#f6e8d9]"
                        : "bg-card text-muted-foreground ring-1 ring-border ring-inset"
                    }`}
                  >
                    {i + 1}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => openPreview?.(r.documentId as Id<"documents">)}
                  className="truncate font-medium text-[#40233f] underline decoration-transparent underline-offset-2 transition hover:decoration-current"
                  title={`Preview ${label}`}
                >
                  {label}
                </button>
                {r.documentKind && r.documentKind !== doc?.docType && (
                  <span className="text-muted-foreground">
                    · {r.documentKind}
                  </span>
                )}
                {isLatest && timeline && (
                  <span className="rounded-full bg-[#e6f3ed] px-1.5 py-0.5 text-[10px] font-medium text-[#2f5d4b]">
                    latest
                  </span>
                )}
                {lowConfidence && (
                  <span
                    className="rounded-full bg-[#fdecee] px-1.5 py-0.5 text-[10px] font-medium text-[#8a3942]"
                    title={`Low extraction confidence (${Math.round((r.confidence ?? 0) * 100)}%) — value may be an OCR miss.`}
                  >
                    low confidence
                  </span>
                )}
              </div>
              <div className="font-numerals shrink-0 text-foreground tabular-nums">
                {r.display}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <ConfidenceChip value={r.confidence} />
                {onResolveWith && (
                  <button
                    type="button"
                    onClick={() =>
                      onResolveWith(r.documentId as Id<"documents">, r.raw)
                    }
                    className="rounded-full bg-[#40233f] px-2 py-0.5 text-xs text-[#f6e8d9] transition hover:bg-[#593157]"
                    title="Promote this value to the reconciled set"
                  >
                    Use this
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => openPreview?.(r.documentId as Id<"documents">)}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground transition hover:bg-card hover:text-[#40233f]"
                  title="Preview document"
                >
                  <Eye className="size-3" />
                  Preview
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SettledFactRow({
  fact,
  documents,
}: {
  fact: Fact;
  documents: FindingDoc;
}) {
  const isResolved = fact.status === "resolved";
  const isSingle = fact.status === "single-source";
  const dotTone = isResolved
    ? "bg-[#3f668f]"
    : isSingle
      ? "bg-muted-foreground/40"
      : "bg-[#3f7c64]";
  const subtitle = isResolved
    ? `chosen from ${documentLabel(fact.finding?.resolvedDocumentId ?? "", documents)}`
    : isSingle
      ? `from ${fact.evidence[0] ? documentLabel(fact.evidence[0].documentId, documents) : "—"} only`
      : fact.evidence.length > 0
        ? `${fact.evidence.length} ${fact.evidence.length === 1 ? "doc" : "docs"} agree`
        : "";

  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-card px-3 py-2">
      <span
        aria-hidden
        className={`mt-1 size-1.5 shrink-0 rounded-full ${dotTone}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {fact.label}
          </span>
          <span className="font-numerals truncate text-sm text-foreground tabular-nums">
            {fact.agreedDisplay ?? "—"}
          </span>
        </div>
        {subtitle && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
}

type VerificationMethod =
  | "phone_call"
  | "independent"
  | "recording_search"
  | "payoff_on_file"
  | "in_person"
  | "other";

type SuggestedAction = {
  // Primary call-to-action shown on the card.
  label: string;
  // What we'll persist as the verification method when the user accepts.
  method: VerificationMethod;
  // One-line context shown above the form so the processor knows what they're
  // attesting to ("I confirmed the wire payee by phone with the title co.").
  prompt: string;
  // Default note prefix so the audit trail isn't an empty string.
  defaultNote?: string;
};

const VERIFICATION_LABELS: Record<VerificationMethod, string> = {
  phone_call: "Phone call",
  independent: "Independent source",
  recording_search: "Recorder search",
  payoff_on_file: "Payoff letter on file",
  in_person: "In person",
  other: "Other",
};

function suggestedActionFor(findingType: string): SuggestedAction | null {
  switch (findingType) {
    case "wire.payee_unknown":
    case "wire.payee_partial_match":
    case "wire.payee_missing":
    case "wire.amount_unusual":
      return {
        label: "I confirmed the wire by phone",
        method: "phone_call",
        prompt:
          "Call the payee at a number from a prior independent document — never the number on the wire instructions.",
      };
    case "owner_of_record_mismatch":
      return {
        label: "I confirmed the chain of title",
        method: "recording_search",
        prompt:
          "Confirm the chain of title via the recorder before accepting the seller of record.",
      };
    case "parcel_apn_mismatch":
      return {
        label: "I confirmed the parcel",
        method: "independent",
        prompt:
          "Confirm the address-to-parcel mapping with the county or a recent recorded instrument.",
      };
    case "open_lien_no_release":
      return {
        label: "Payoff letters are on file",
        method: "payoff_on_file",
        prompt:
          "Each unmatched lien needs a payoff letter or recorded satisfaction in the file.",
      };
    case "trust_without_trustee":
    case "estate_without_executor":
    case "joint_vesting_unclear":
    case "party_capacity_mismatch":
    case "poa_present":
    case "decedent_indicator":
      return {
        label: "I confirmed signing authority",
        method: "independent",
        prompt:
          "Vesting and authority must match the deed and any underlying instruments (POA, trust, probate).",
      };
    case "missing_required_documents":
      return {
        label: "Docs are accounted for",
        method: "in_person",
        prompt:
          "Confirm the missing transaction-type docs are in the file (or marked not applicable).",
      };
    case "earnest_money_refundability_change":
      return {
        label: "I confirmed EM with both parties",
        method: "phone_call",
        prompt:
          "Mishandling earnest money is a frequent EM dispute — get refundability in writing from both sides.",
      };
    case "sale_price_variance_market":
      return {
        label: "Variance is expected",
        method: "independent",
        prompt:
          "Distressed / family / portfolio transfers regularly diverge from county market value.",
      };
    default:
      return null;
  }
}

function OtherIssueCard({
  finding,
  documents,
  onSetStatus,
  onVerify,
}: {
  finding: Finding;
  documents: FindingDoc;
  onSetStatus: (
    findingId: Id<"reconciliationFindings">,
    status: "acknowledged" | "resolved" | "dismissed",
  ) => void;
  onVerify?: (
    findingId: Id<"reconciliationFindings">,
    method: VerificationMethod,
    note?: string,
  ) => Promise<void> | void;
}) {
  const sev = finding.severity;
  const tone =
    sev === "block"
      ? {
          border: "border-[#b94f58]/40",
          bg: "bg-[#fdecee]/40",
          text: "text-[#8a3942]",
          chip: "bg-[#fdecee] text-[#8a3942]",
          dot: "bg-[#b94f58]",
        }
      : sev === "warn"
        ? {
            border: "border-[#c9652e]/35",
            bg: "bg-[#fde9dc]/40",
            text: "text-[#7a3d18]",
            chip: "bg-[#fde9dc] text-[#7a3d18]",
            dot: "bg-[#c9652e]",
          }
        : {
            border: "border-[#3f668f]/35",
            bg: "bg-[#e8f0f8]/50",
            text: "text-[#2c4a6b]",
            chip: "bg-[#e8f0f8] text-[#2c4a6b]",
            dot: "bg-[#3f668f]",
          };

  const openPreview = useDocumentPreview();
  const involved = finding.involvedDocumentIds.filter((id) =>
    documents.find((d) => d._id === id),
  );

  const suggested = suggestedActionFor(finding.findingType);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [method, setMethod] = useState<VerificationMethod | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Reset the inline form when the user collapses it.
  useEffect(() => {
    if (!verifyOpen) {
      setNote("");
      setSubmitting(false);
    } else {
      setMethod(suggested?.method ?? "in_person");
    }
  }, [verifyOpen, suggested]);

  const handleVerify = async () => {
    if (!onVerify || !method) return;
    setSubmitting(true);
    try {
      await onVerify(
        finding._id as Id<"reconciliationFindings">,
        method,
        note.trim() || undefined,
      );
      setVerifyOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className={`rounded-xl border ${tone.border} ${tone.bg} p-3.5 ring-1 ring-inset ${tone.border.replace("border", "ring")}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone.chip}`}
          >
            <span className={`size-1 rounded-full ${tone.dot}`} />
            {sev === "block" ? "Blocker" : sev === "warn" ? "Warning" : "Note"}
          </span>
          <span className={`text-xs font-medium ${tone.text}`}>
            {finding.findingType.replace(/_/g, " ")}
          </span>
          {finding.status === "acknowledged" && (
            <span className="rounded-full bg-card px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border ring-inset">
              acknowledged
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {suggested && onVerify && (
            <button
              type="button"
              onClick={() => setVerifyOpen((v) => !v)}
              aria-expanded={verifyOpen}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone.chip} ring-1 ring-inset ${tone.border}`}
            >
              <Check className="size-3" />
              {suggested.label}
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              onSetStatus(
                finding._id as Id<"reconciliationFindings">,
                "acknowledged",
              )
            }
            className="rounded-full px-2 py-0.5 text-xs text-muted-foreground transition hover:bg-card hover:text-[#40233f]"
          >
            Acknowledge
          </button>
          <button
            type="button"
            onClick={() =>
              onSetStatus(
                finding._id as Id<"reconciliationFindings">,
                "dismissed",
              )
            }
            className="rounded-full px-2 py-0.5 text-xs text-muted-foreground transition hover:bg-card hover:text-[#40233f]"
          >
            Not relevant
          </button>
        </div>
      </div>

      <p className={`mt-1.5 text-sm ${tone.text}`}>{finding.message}</p>

      {verifyOpen && suggested && onVerify && (
        <div className="mt-2.5 rounded-lg bg-card/80 p-3 ring-1 ring-border ring-inset">
          <p className="text-xs leading-snug text-muted-foreground">
            {suggested.prompt}
          </p>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
              <span>Verified via</span>
              <select
                value={method ?? suggested.method}
                onChange={(e) =>
                  setMethod(e.target.value as VerificationMethod)
                }
                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
              >
                {(
                  [
                    "phone_call",
                    "independent",
                    "recording_search",
                    "payoff_on_file",
                    "in_person",
                    "other",
                  ] as VerificationMethod[]
                ).map((m) => (
                  <option key={m} value={m}>
                    {VERIFICATION_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground sm:col-span-1">
              <span>Note (optional)</span>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Who did you talk to? Reference doc?"
                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
              />
            </label>
          </div>
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setVerifyOpen(false)}
              disabled={submitting}
              className="rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleVerify}
              disabled={submitting || !method}
              className="rounded-full bg-[#40233f] px-3 py-1 text-xs font-semibold text-white transition hover:bg-[#593157] disabled:opacity-50"
            >
              {submitting ? "Saving…" : "Verify & resolve"}
            </button>
          </div>
        </div>
      )}

      {involved.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>In:</span>
          {involved.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => openPreview?.(id as Id<"documents">)}
              className="inline-flex items-center gap-1 rounded-full bg-card px-2 py-0.5 text-xs text-[#40233f] ring-1 ring-border transition ring-inset hover:bg-muted"
              title={`Preview ${documentLabel(id, documents)}`}
            >
              <Eye className="size-3" />
              {documentLabel(id, documents)}
            </button>
          ))}
        </div>
      )}

      {import.meta.env.DEV && finding.rawDetail !== undefined && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-[#40233f]">
            Raw detail (debug)
          </summary>
          <pre className="mt-1 overflow-x-auto rounded bg-card/70 p-2 text-xs leading-tight text-foreground/70">
            {JSON.stringify(finding.rawDetail, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function PrereqBanner({
  property,
  parties,
  docs,
}: {
  property: boolean;
  parties: boolean;
  docs: boolean;
}) {
  const items: Array<{ todo: boolean; label: string; anchor: string }> = [
    {
      todo: property,
      label: "Add the property address",
      anchor: "#step-property",
    },
    { todo: parties, label: "Add at least 2 parties", anchor: "#step-parties" },
    {
      todo: docs,
      label: "Upload at least one document and let it extract",
      anchor: "#step-documents",
    },
  ];
  return (
    <div className="rounded-xl border border-[#b78625]/35 bg-[#fdf6e8] px-4 py-3 ring-1 ring-[#b78625]/15 ring-inset">
      <div className="flex items-center gap-2 text-xs font-medium text-[#7a5818]">
        <CircleAlert className="size-3.5" />
        Finish these to make reconcile useful
      </div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {items.map(
          (it) =>
            it.todo && (
              <li key={it.label}>
                <a
                  href={it.anchor}
                  className="group/jump flex items-center gap-2 text-sm text-[#7a5818] hover:text-[#40233f]"
                >
                  <span className="grid size-4 shrink-0 place-items-center rounded-full bg-[#f8eed7] text-xs font-semibold text-[#7a5818] ring-1 ring-[#b78625]/30">
                    !
                  </span>
                  {it.label}
                  <ArrowRight className="size-3 opacity-0 transition group-hover/jump:translate-x-0.5 group-hover/jump:opacity-100" />
                </a>
              </li>
            ),
        )}
      </ul>
    </div>
  );
}

function SeverityChip({
  count,
  severity,
  active,
  onClick,
  disabled,
}: {
  count: number;
  severity: "block" | "warn" | "info";
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  const tone =
    severity === "block"
      ? {
          ring: "ring-[#b94f58]/40",
          text: "text-[#8a3942]",
          bg: "bg-[#fdecee]",
          dot: "bg-[#b94f58]",
        }
      : severity === "warn"
        ? {
            ring: "ring-[#c9652e]/40",
            text: "text-[#7a3d18]",
            bg: "bg-[#fde9dc]",
            dot: "bg-[#c9652e]",
          }
        : {
            ring: "ring-[#3f668f]/40",
            text: "text-[#2c4a6b]",
            bg: "bg-[#e8f0f8]",
            dot: "bg-[#3f668f]",
          };
  // Empty / disabled state — render as static pill, no toggle.
  if (count === 0 || disabled) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground ring-1 ring-border ring-inset"
        aria-label={`${severity} count: ${count}`}
      >
        {severity} · {count}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={active ? `Hide ${severity}` : `Show ${severity}`}
      className={`font-numerals inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs tabular-nums ring-1 transition ring-inset ${
        active
          ? `${tone.ring} ${tone.text} ${tone.bg}`
          : "bg-card/60 text-muted-foreground opacity-60 ring-border hover:opacity-100"
      }`}
    >
      <span className={`size-1 rounded-full ${tone.dot}`} />
      {severity} · {count}
    </button>
  );
}

function documentLabel(documentId: string, documents: FindingDoc): string {
  const doc = documents.find((d) => d._id === documentId);
  if (!doc) return "(unknown document)";
  return doc.title ?? doc.docType;
}

function lookupConfidence(
  conf: Record<string, number> | undefined,
  fieldPath: string | null,
): number | undefined {
  if (!conf || !fieldPath) return undefined;
  if (fieldPath in conf) return conf[fieldPath];
  const [head, ...rest] = fieldPath.split(".");
  if (rest.length === 0) return undefined;
  const tail = rest.join(".");
  const prefix = `${head}[`;
  const matches: number[] = [];
  for (const [k, v] of Object.entries(conf)) {
    if (k.startsWith(prefix) && k.endsWith(`].${tail}`)) {
      matches.push(v);
    }
  }
  if (matches.length === 0) return undefined;
  return Math.min(...matches);
}

function ConfidenceChip({ value }: { value?: number }) {
  if (value === undefined) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-[#e6f3ed] px-1.5 py-0.5 text-xs text-[#2f5d4b]"
        title="No confidence reported — treated as fully confident."
      >
        high
      </span>
    );
  }
  const pct = Math.round(value * 100);
  const tone =
    value >= 0.85
      ? "bg-[#e6f3ed] text-[#2f5d4b]"
      : value >= 0.65
        ? "bg-[#f8eed7] text-[#7a5818]"
        : "bg-[#fdecee] text-[#8a3942]";
  const label = value >= 0.85 ? "high" : value >= 0.65 ? "medium" : "low";
  return (
    <span
      className={`font-numerals inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs tabular-nums ${tone}`}
      title={`LLM-reported confidence: ${pct}%`}
    >
      {label} · {pct}%
    </span>
  );
}

function ReconciledFactsPanel({ file }: { file: Doc<"files"> }) {
  const has =
    file.purchasePrice !== undefined ||
    !!file.titleCompany?.name ||
    file.earnestMoney !== undefined ||
    file.financingApprovalDays !== undefined;
  if (!has) return null;

  const em = file.earnestMoney;
  const tc = file.titleCompany;

  return (
    <SectionShell
      eyebrow="Promoted from reconciliation"
      title="Reconciled facts"
      icon={<Check className="size-4" />}
      description="System of record for downstream closing docs. These were chosen during reconciliation."
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        {file.purchasePrice !== undefined && (
          <KV
            label="Purchase price"
            value={`$${file.purchasePrice.toLocaleString()}`}
            mono
          />
        )}
        {tc?.name && (
          <KV
            label="Title company"
            value={
              <>
                {tc.name}
                {tc.selectedBy && (
                  <div className="text-xs text-muted-foreground">
                    selected by {tc.selectedBy}
                  </div>
                )}
              </>
            }
          />
        )}
        {em && (em.amount !== undefined || em.refundable !== undefined) && (
          <KV
            label="Earnest money"
            value={
              <>
                {typeof em.amount === "number"
                  ? `$${em.amount.toLocaleString()}`
                  : "—"}
                {em.refundable !== undefined && (
                  <div className="text-xs text-muted-foreground">
                    {em.refundable ? "refundable" : "non-refundable"}
                    {typeof em.depositDays === "number"
                      ? ` · ${em.depositDays}d window`
                      : ""}
                  </div>
                )}
              </>
            }
            mono
          />
        )}
        {file.financingApprovalDays !== undefined && (
          <KV
            label="Financing window"
            value={`${file.financingApprovalDays} days`}
            mono
          />
        )}
      </dl>
    </SectionShell>
  );
}

const DOC_TYPES = [
  { code: "deed", label: "Deed" },
  { code: "mortgage", label: "Mortgage" },
  { code: "release", label: "Release" },
  { code: "assignment", label: "Assignment" },
  { code: "deed_of_trust", label: "Deed of trust" },
] as const;

type DocType = (typeof DOC_TYPES)[number]["code"];

function RulesPanel({ fileId }: { fileId: Id<"files"> }) {
  const [docType, setDocType] = useState<DocType>("deed");
  const rule = useQuery(
    convexQuery(api.rules.resolveForFile, { fileId, docType }),
  );

  return (
    <SectionShell
      eyebrow="The codex"
      title="Recording rules"
      icon={<ScrollText className="size-4" />}
      description="Resolved against the file's county at the file's openedAt. The rule that was in force when this file opened."
      actions={
        <Select value={docType} onValueChange={(v) => setDocType(v as DocType)}>
          <SelectTrigger size="sm" className="text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DOC_TYPES.map((d) => (
              <SelectItem key={d.code} value={d.code}>
                {d.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {rule.isLoading ? (
        <Loading size="sm" label="Reading the codex" />
      ) : !rule.data ? (
        <EmptyHint
          icon={<CircleHelp className="size-4" />}
          title="No rules configured for this county + doc type"
          body="Closings can proceed but expect manual handling for recording requirements."
        />
      ) : (
        <RuleCard rule={rule.data} />
      )}
    </SectionShell>
  );
}

function RuleCard({ rule }: { rule: Doc<"countyRecordingRules"> }) {
  const r = rule.rules;
  const fees = r.feeSchedule as
    | {
        firstPage?: number;
        additionalPage?: number;
        salesDisclosureFee?: number;
      }
    | undefined;
  const sig = r.signaturePageRequirements as
    | {
        notarized?: boolean;
        witnessRequired?: boolean;
        printedNameBeneathSignature?: boolean;
      }
    | undefined;
  return (
    <div>
      <div className="font-numerals mb-3 inline-flex items-center gap-2 rounded-md border border-border/60 bg-[#fdf6e8] px-2.5 py-1 text-xs text-[#40233f] tabular-nums">
        v{rule.version} · effective from{" "}
        {new Date(rule.effectiveFrom).toLocaleDateString()}
        {rule.effectiveTo
          ? ` until ${new Date(rule.effectiveTo).toLocaleDateString()}`
          : " · in force"}
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        <KV label="Page size" value={r.pageSize ?? "—"} />
        <KV
          label="Margins (TBLR)"
          value={
            r.margins
              ? `${r.margins.top} · ${r.margins.bottom} · ${r.margins.left} · ${r.margins.right}`
              : "—"
          }
          mono
        />
        <KV
          label="Required exhibits"
          value={
            r.requiredExhibits.length > 0
              ? r.requiredExhibits.join(", ")
              : "none"
          }
        />
        <KV
          label="Fees"
          value={
            <>
              {fees?.firstPage !== undefined
                ? `$${fees.firstPage} first / $${fees.additionalPage ?? 0} ea.`
                : "—"}
              {fees?.salesDisclosureFee
                ? ` · SDF $${fees.salesDisclosureFee}`
                : ""}
            </>
          }
          mono
        />
        <KV
          label="Signatures"
          value={
            <>
              {sig?.notarized ? "notarized" : "—"}
              {sig?.witnessRequired ? ", witness required" : ""}
              {sig?.printedNameBeneathSignature ? ", printed name" : ""}
            </>
          }
        />
      </dl>
    </div>
  );
}

type AuditActor =
  | {
      kind: "member";
      memberId: string;
      email: string;
      name: string | null;
      role: string;
    }
  | { kind: "system" }
  | { kind: "unknown"; type: string };

type AuditEvent = {
  _id: string;
  action: string;
  occurredAt: number;
  metadata?: unknown;
  actor?: AuditActor;
};

const ACTION_VERBS: Record<string, string> = {
  "file.created": "opened the file",
  "file.status_changed": "changed the status",
  "file.party_added": "added a party",
  "file.party_removed": "removed a party",
  "file.updated": "updated file details",
  "document.uploaded": "uploaded a document",
  "document.deleted": "deleted a document",
  "documents.deduped": "removed duplicate documents",
  "extraction.requested": "started an extraction",
  "extraction.succeeded": "completed an extraction",
  "extraction.failed": "extraction failed",
  "reconciliation.run": "ran reconciliation",
  "reconciliation.finding_resolved": "resolved a finding",
  "reconciliation.finding_acknowledged": "acknowledged a finding",
  "reconciliation.finding_dismissed": "dismissed a finding",
  "secret.issued": "issued a tokenized secret",
  "secret.revealed": "revealed a tokenized secret",
};

function describeAction(action: string): string {
  return (
    ACTION_VERBS[action] ??
    action
      .split(".")
      .pop()!
      .replace(/_/g, " ")
      .replace(/^./, (c) => c.toLowerCase())
  );
}

function actionDetail(e: AuditEvent): string | null {
  const md = (e.metadata ?? {}) as Record<string, unknown>;
  switch (e.action) {
    case "file.status_changed":
      if (md.from && md.to) return `${md.from} → ${md.to}`;
      return null;
    case "file.party_added":
    case "file.party_removed":
      if (typeof md.legalName === "string" && typeof md.role === "string") {
        return `${md.legalName} · ${md.role}`;
      }
      return null;
    case "document.uploaded":
    case "document.deleted":
      if (typeof md.docType === "string") {
        const kb =
          typeof md.sizeBytes === "number"
            ? ` · ${(md.sizeBytes / 1024).toFixed(1)} KB`
            : "";
        return `${md.docType.replace(/_/g, " ")}${kb}`;
      }
      return null;
    case "documents.deduped":
      if (typeof md.removed === "number") {
        return `${md.removed} document${md.removed === 1 ? "" : "s"} removed`;
      }
      return null;
    case "extraction.requested":
      if (typeof md.docType === "string") {
        return md.source === "auto"
          ? `${md.docType.replace(/_/g, " ")} · auto`
          : md.docType.replace(/_/g, " ");
      }
      return null;
    default:
      return null;
  }
}

function AuditPanel({ events }: { events: ReadonlyArray<AuditEvent> }) {
  return (
    <SectionShell
      eyebrow="Provenance"
      title="Activity"
      icon={<History className="size-4" />}
      description="Every change to this file, in order — including who did it."
    >
      {events.length === 0 ? (
        <EmptyHint
          icon={<History className="size-4" />}
          title="No activity yet"
          body="Actions will appear here as the file moves through the workflow."
        />
      ) : (
        <ol className="relative">
          <div
            aria-hidden
            className="absolute top-2 bottom-2 left-[1.5rem] w-px bg-gradient-to-b from-transparent via-border to-transparent"
          />
          {events.map((e, i) => (
            <ActivityRow key={e._id} event={e} latest={i === 0} />
          ))}
        </ol>
      )}
    </SectionShell>
  );
}

function ActivityRow({
  event,
  latest,
}: {
  event: AuditEvent;
  latest: boolean;
}) {
  const verb = describeAction(event.action);
  const detail = actionDetail(event);
  const actor = event.actor;
  const actorLabel =
    actor?.kind === "member"
      ? actor.name && actor.name.trim().length > 0
        ? actor.name
        : actor.email
      : actor?.kind === "system"
        ? "System"
        : "Unknown";
  const actorSub =
    actor?.kind === "member"
      ? actor.name && actor.name.trim().length > 0
        ? `${actor.email} · ${actor.role}`
        : actor.role
      : actor?.kind === "system"
        ? "automated"
        : null;

  return (
    <li className="relative grid grid-cols-[3rem_1fr_auto] items-start gap-3 py-3">
      <div className="relative flex justify-center">
        <ActorAvatar actor={actor} latest={latest} />
      </div>
      <div className="min-w-0">
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
        {actorSub && (
          <div className="mt-0.5 text-xs text-muted-foreground">{actorSub}</div>
        )}
      </div>
      <div className="font-numerals text-right text-xs text-muted-foreground tabular-nums">
        {new Date(event.occurredAt).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
      </div>
    </li>
  );
}

function ActorAvatar({
  actor,
  latest,
}: {
  actor?: AuditActor;
  latest: boolean;
}) {
  if (actor?.kind === "system") {
    return (
      <div
        className={`relative z-10 grid size-7 place-items-center rounded-full bg-[#40233f] text-[#f4d48f] ring-4 ring-card ${
          latest ? "" : "opacity-90"
        }`}
        title="System action"
      >
        <Sparkles className="size-3" />
      </div>
    );
  }
  if (actor?.kind === "member") {
    const initials = personInitials(actor.name, actor.email);
    return (
      <div className="relative z-10 grid size-7 place-items-center rounded-full border border-[#40233f]/15 bg-[#fdf6e8] text-xs font-semibold text-[#40233f] ring-4 ring-card">
        {initials}
      </div>
    );
  }
  return (
    <div className="relative z-10 grid size-7 place-items-center rounded-full bg-muted text-xs font-medium text-muted-foreground ring-4 ring-card">
      ?
    </div>
  );
}

function personInitials(name?: string | null, email?: string | null): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/).slice(0, 2);
    return parts
      .map((p) => p[0])
      .join("")
      .toUpperCase();
  }
  if (email) {
    const local = email.split("@")[0] ?? email;
    const segs = local.split(/[._-]+/).filter(Boolean);
    if (segs.length >= 2) return (segs[0]![0]! + segs[1]![0]!).toUpperCase();
    return (local.slice(0, 2) || "··").toUpperCase();
  }
  return "··";
}
