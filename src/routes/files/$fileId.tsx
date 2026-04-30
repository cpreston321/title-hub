import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { convexQuery, useConvexMutation } from "@convex-dev/react-query"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { AppShell } from "@/components/app-shell"
import { api } from "../../../convex/_generated/api"
import type { Doc, Id } from "../../../convex/_generated/dataModel"

export const Route = createFileRoute("/files/$fileId")({
  beforeLoad: ({ context }) => {
    if (!(context as { isAuthenticated?: boolean }).isAuthenticated) {
      throw redirect({ to: "/signin" })
    }
  },
  component: FileDetailPage,
})

function FileDetailPage() {
  const { fileId } = Route.useParams()
  const id = fileId as Id<"files">
  const detail = useQuery(convexQuery(api.files.get, { fileId: id }))
  const audit = useQuery(convexQuery(api.audit.listForFile, { fileId: id }))
  const extractions = useQuery(
    convexQuery(api.extractions.listForFile, { fileId: id }),
  )

  if (detail.error) {
    return (
      <AppShell isAuthenticated title="File">
        <p className="text-destructive text-sm">
          Error: {detail.error.message}
        </p>
      </AppShell>
    )
  }

  if (detail.isLoading || !detail.data) {
    return (
      <AppShell isAuthenticated title="File">
        <p className="text-muted-foreground text-sm">Loading...</p>
      </AppShell>
    )
  }

  const { file, county, parties, documents } = detail.data
  const events = audit.data ?? []

  // documentId → _confidence map (path → 0..1). Missing path ⇒ 1.0.
  const confidenceByDoc = new Map<string, Record<string, number>>()
  for (const e of extractions.data ?? []) {
    const payload = e.payload as { _confidence?: Record<string, number> } | null
    if (payload && payload._confidence) {
      confidenceByDoc.set(e.documentId, payload._confidence)
    }
  }

  return (
    <AppShell
      isAuthenticated
      title={file.fileNumber}
      subtitle={`${file.transactionType} · ${county?.name} County, ${file.stateCode}`}
      actions={
        <Badge
          variant={
            file.status === "cancelled"
              ? "destructive"
              : file.status === "opened" || file.status === "in_exam"
                ? "secondary"
                : "default"
          }
          className="text-[10px] uppercase tracking-wide"
        >
          {file.status}
        </Badge>
      }
    >
      <div className="flex flex-col gap-6">
        <Link
          to="/files"
          className="text-muted-foreground self-start text-xs underline"
        >
          ← Files
        </Link>

        <FindingsPanel
          fileId={id}
          documents={documents}
          confidenceByDoc={confidenceByDoc}
        />
        <PropertyDetailsPanel fileId={id} file={file} />
        <RulesPanel fileId={id} />
        <PartiesPanel fileId={id} parties={parties} />
        <DocumentsPanel fileId={id} documents={documents} />
        <AuditPanel events={events} />
      </div>
    </AppShell>
  )
}

const SEVERITY_STYLES: Record<string, string> = {
  block: "border-rose-300 bg-rose-50 text-rose-900",
  warn: "border-amber-300 bg-amber-50 text-amber-900",
  info: "border-sky-200 bg-sky-50 text-sky-900",
}

const SEVERITY_LABEL: Record<string, string> = {
  block: "Blockers",
  warn: "Warnings",
  info: "Info",
}

const SEVERITY_ORDER = ["block", "warn", "info"] as const

type FindingDoc = ReadonlyArray<{
  _id: string
  title?: string
  docType: string
}>

type Finding = {
  _id: string
  findingType: string
  severity: "info" | "warn" | "block"
  message: string
  involvedDocumentIds: ReadonlyArray<string>
  involvedFields: ReadonlyArray<string>
  rawDetail: unknown
  status: "open" | "acknowledged" | "resolved" | "dismissed"
  resolvedDocumentId?: string
  resolvedValue?: unknown
}

function FindingsPanel({
  fileId,
  documents,
  confidenceByDoc,
}: {
  fileId: Id<"files">
  documents: FindingDoc
  confidenceByDoc: Map<string, Record<string, number>>
}) {
  const findings = useQuery(
    convexQuery(api.reconciliation.listForFile, { fileId }),
  )
  const reconcile = useConvexMutation(api.reconciliation.runForFile)
  const setStatus = useConvexMutation(api.reconciliation.setStatus)
  const resolveWith = useConvexMutation(api.reconciliation.resolveWith)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onReconcile = async () => {
    setBusy(true)
    setError(null)
    try {
      await reconcile({ fileId })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onAck = async (
    findingId: Id<"reconciliationFindings">,
    status: "acknowledged" | "resolved" | "dismissed",
  ) => {
    try {
      await setStatus({ findingId, status })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onResolveWith = async (
    findingId: Id<"reconciliationFindings">,
    documentId: Id<"documents">,
    value: unknown,
  ) => {
    try {
      await resolveWith({ findingId, documentId, value })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const list = (findings.data ?? []) as ReadonlyArray<Finding>
  const open = list.filter((f) => f.status === "open")
  const closed = list.filter((f) => f.status !== "open")

  const counts = {
    block: open.filter((f) => f.severity === "block").length,
    warn: open.filter((f) => f.severity === "warn").length,
    info: open.filter((f) => f.severity === "info").length,
  }
  const total = counts.block + counts.warn + counts.info

  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between">
        <div>
          <CardTitle>Reconciliation</CardTitle>
          <CardDescription>
            Side-by-side evidence from each uploaded document. Resolve a
            blocker before drafting closing docs.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <SeverityChip count={counts.block} severity="block" />
          <SeverityChip count={counts.warn} severity="warn" />
          <SeverityChip count={counts.info} severity="info" />
          <Button onClick={onReconcile} disabled={busy}>
            {busy ? "Running..." : "Reconcile"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <p className="text-destructive text-sm">{error}</p>}

        {total === 0 ? (
          <div className="text-muted-foreground rounded-md border border-dashed border-border/60 p-3 text-sm">
            No open findings. Upload the purchase agreement, counter offers,
            and commitment, run Extract on each, then click Reconcile.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {SEVERITY_ORDER.map((sev) => {
              const items = open.filter((f) => f.severity === sev)
              if (items.length === 0) return null
              return (
                <section key={sev} className="flex flex-col gap-2">
                  <h3 className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
                    {SEVERITY_LABEL[sev]} · {items.length}
                  </h3>
                  {items.map((f) => (
                    <FindingCard
                      key={f._id}
                      finding={f}
                      documents={documents}
                      confidenceByDoc={confidenceByDoc}
                      onSetStatus={onAck}
                      onResolveWith={onResolveWith}
                    />
                  ))}
                </section>
              )
            })}
          </div>
        )}

        {closed.length > 0 && (
          <details className="text-muted-foreground text-xs">
            <summary className="cursor-pointer">
              {closed.length} closed finding{closed.length === 1 ? "" : "s"}
            </summary>
            <ul className="mt-1 flex flex-col gap-1">
              {closed.map((f) => (
                <li key={f._id} className="rounded border p-2">
                  <div>
                    {f.status} · {f.findingType} · {f.message}
                  </div>
                  {f.resolvedDocumentId && (
                    <div className="mt-1 text-[11px] text-emerald-800">
                      → chose{" "}
                      <span className="font-medium">
                        {documentLabel(f.resolvedDocumentId, documents)}
                      </span>
                      {f.resolvedValue !== undefined &&
                        f.resolvedValue !== null && (
                          <>
                            {" "}
                            · {formatResolvedValue(f.resolvedValue)}
                          </>
                        )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  )
}

function SeverityChip({
  count,
  severity,
}: {
  count: number
  severity: "block" | "warn" | "info"
}) {
  if (count === 0) {
    return (
      <span className="text-muted-foreground rounded-full border border-dashed px-2 py-0.5 text-[10px] uppercase tracking-wide">
        {severity} 0
      </span>
    )
  }
  const cls = SEVERITY_STYLES[severity]
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}
    >
      {severity} {count}
    </span>
  )
}

function FindingCard({
  finding,
  documents,
  confidenceByDoc,
  onSetStatus,
  onResolveWith,
}: {
  finding: Finding
  documents: FindingDoc
  confidenceByDoc: Map<string, Record<string, number>>
  onSetStatus: (
    findingId: Id<"reconciliationFindings">,
    status: "acknowledged" | "resolved" | "dismissed",
  ) => void
  onResolveWith: (
    findingId: Id<"reconciliationFindings">,
    documentId: Id<"documents">,
    value: unknown,
  ) => void
}) {
  const evidence = evidenceFromFinding(finding)
  const latest = latestFromFinding(finding)
  const cls = SEVERITY_STYLES[finding.severity] ?? ""

  return (
    <div className={`rounded-md border p-3 text-sm ${cls}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide">
          {finding.findingType.replace(/_/g, " ")}
        </span>
        <div className="flex gap-1">
          <Button
            type="button"
            variant="link"
            size="xs"
            onClick={() =>
              onSetStatus(
                finding._id as Id<"reconciliationFindings">,
                "acknowledged",
              )
            }
          >
            ack
          </Button>
          {evidence.length === 0 && (
            <Button
              type="button"
              variant="link"
              size="xs"
              onClick={() =>
                onSetStatus(
                  finding._id as Id<"reconciliationFindings">,
                  "resolved",
                )
              }
            >
              resolve
            </Button>
          )}
          <Button
            type="button"
            variant="link"
            size="xs"
            onClick={() =>
              onSetStatus(
                finding._id as Id<"reconciliationFindings">,
                "dismissed",
              )
            }
          >
            dismiss
          </Button>
        </div>
      </div>
      <p className="mt-1">{finding.message}</p>

      {evidence.length > 0 && (
        <FindingEvidence
          rows={evidence}
          documents={documents}
          authoritativeDocId={latest?.documentId}
          confidenceByDoc={confidenceByDoc}
          confidenceFieldPath={confidenceFieldPathFor(finding.findingType)}
          onResolveWith={(documentId, value) =>
            onResolveWith(
              finding._id as Id<"reconciliationFindings">,
              documentId,
              value,
            )
          }
        />
      )}

      {latest && (
        <p className="mt-2 text-xs">
          <span className="font-semibold">Latest controls:</span>{" "}
          {documentLabel(latest.documentId, documents)}
          {latest.value !== undefined && <> · {latest.value}</>}
        </p>
      )}

      <details className="mt-2 text-xs opacity-80">
        <summary className="cursor-pointer">Raw detail</summary>
        <pre className="mt-1 overflow-x-auto rounded bg-black/5 p-2 text-[10px] leading-tight">
          {JSON.stringify(finding.rawDetail, null, 2)}
        </pre>
      </details>
    </div>
  )
}

type EvidenceRow = {
  documentId: string
  documentKind?: string
  value: string
  raw: unknown
}

function evidenceFromFinding(f: Finding): EvidenceRow[] {
  const rd = (f.rawDetail ?? {}) as Record<string, unknown>
  const values = (rd.values ?? []) as Array<Record<string, unknown>>

  switch (f.findingType) {
    case "price_mismatch":
    case "price_amended":
      return values.map((v) => ({
        documentId: String(v.documentId),
        documentKind: v.documentKind as string | undefined,
        value:
          typeof v.purchasePrice === "number"
            ? `$${v.purchasePrice.toLocaleString()}`
            : "—",
        raw: v.purchasePrice,
      }))
    case "title_company_change":
    case "title_company_set": {
      return values.map((v) => {
        const tc = v.titleCompany as
          | { name?: string; selectedBy?: string }
          | undefined
        return {
          documentId: String(v.documentId),
          documentKind: v.documentKind as string | undefined,
          value: tc?.name
            ? `${tc.name}${tc.selectedBy ? ` · selected by ${tc.selectedBy}` : ""}`
            : "—",
          raw: tc,
        }
      })
    }
    case "earnest_money_refundability_change":
      return values.map((v) => {
        const em = v.earnestMoney as
          | { amount?: number; refundable?: boolean }
          | undefined
        const refund =
          em?.refundable === true
            ? "refundable"
            : em?.refundable === false
              ? "non-refundable"
              : "—"
        const amt =
          typeof em?.amount === "number"
            ? ` · $${em.amount.toLocaleString()}`
            : ""
        return {
          documentId: String(v.documentId),
          documentKind: v.documentKind as string | undefined,
          value: `${refund}${amt}`,
          raw: em,
        }
      })
    case "closing_date_mismatch":
      return values.map((v) => ({
        documentId: String(v.documentId),
        documentKind: v.documentKind as string | undefined,
        value: (v.closingDate as string | undefined) ?? "—",
        raw: v.closingDate,
      }))
    case "financing_window_change":
      return values.map((v) => ({
        documentId: String(v.documentId),
        documentKind: v.documentKind as string | undefined,
        value:
          typeof v.financingApprovalDays === "number"
            ? `${v.financingApprovalDays} days`
            : "—",
        raw: v.financingApprovalDays,
      }))
    case "party_name_mismatch": {
      const perDoc = (rd.perDoc ?? []) as Array<Record<string, unknown>>
      return perDoc.map((v) => ({
        documentId: String(v.documentId),
        documentKind: v.documentKind as string | undefined,
        value: String(v.legalName ?? "—"),
        raw: v.legalName,
      }))
    }
    case "party_capacity_mismatch": {
      const entries = (rd.entries ?? []) as Array<Record<string, unknown>>
      return entries.map((v) => ({
        documentId: String(v.documentId),
        documentKind: v.documentKind as string | undefined,
        value: (v.capacity as string | undefined) ?? "(none)",
        raw: v.capacity ?? null,
      }))
    }
    default:
      return []
  }
}

function formatResolvedValue(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "number") {
    // Heuristic: if it's a money-shaped number (>1000), format with $.
    return value > 1000 ? `$${value.toLocaleString()}` : String(value)
  }
  if (typeof value === "string") return value
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>
    if (typeof obj.name === "string") return obj.name
    if (typeof obj.refundable === "boolean") {
      return obj.refundable ? "refundable" : "non-refundable"
    }
    return JSON.stringify(value)
  }
  return String(value)
}

function latestFromFinding(
  f: Finding,
): { documentId: string; value?: string } | null {
  const rd = (f.rawDetail ?? {}) as Record<string, unknown>
  const latest = rd.latest as
    | { documentId?: string; price?: number }
    | undefined
  if (!latest?.documentId) return null
  return {
    documentId: latest.documentId,
    value:
      typeof latest.price === "number"
        ? `$${latest.price.toLocaleString()}`
        : undefined,
  }
}

function documentLabel(documentId: string, documents: FindingDoc): string {
  const doc = documents.find((d) => d._id === documentId)
  if (!doc) return "(unknown document)"
  return doc.title ?? doc.docType
}

function FindingEvidence({
  rows,
  documents,
  authoritativeDocId,
  confidenceByDoc,
  confidenceFieldPath,
  onResolveWith,
}: {
  rows: EvidenceRow[]
  documents: FindingDoc
  authoritativeDocId?: string
  confidenceByDoc: Map<string, Record<string, number>>
  confidenceFieldPath: string | null
  onResolveWith: (documentId: Id<"documents">, value: unknown) => void
}) {
  return (
    <div className="mt-2 overflow-hidden rounded-md border border-current/20 bg-background/60">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground bg-muted/40">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Document</th>
            <th className="px-2 py-1 text-left font-medium">Value</th>
            <th className="px-2 py-1 text-left font-medium">Confidence</th>
            <th className="px-2 py-1 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const doc = documents.find((d) => d._id === r.documentId)
            const label = doc?.title ?? doc?.docType ?? "(unknown)"
            const isAuthoritative = r.documentId === authoritativeDocId
            const confidence = lookupConfidence(
              confidenceByDoc.get(r.documentId),
              confidenceFieldPath,
            )
            return (
              <tr key={`${r.documentId}-${i}`} className="border-t">
                <td className="px-2 py-1">
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="font-medium">{label}</span>
                    {r.documentKind && r.documentKind !== doc?.docType && (
                      <span className="text-muted-foreground">
                        · classified {r.documentKind}
                      </span>
                    )}
                    {isAuthoritative && (
                      <span className="rounded-sm bg-emerald-100 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-900">
                        latest
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-2 py-1 font-mono">{r.value}</td>
                <td className="px-2 py-1">
                  <ConfidenceChip value={confidence} />
                </td>
                <td className="px-2 py-1 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      type="button"
                      variant="link"
                      size="xs"
                      onClick={() =>
                        onResolveWith(
                          r.documentId as Id<"documents">,
                          r.raw,
                        )
                      }
                    >
                      use this
                    </Button>
                    <DocLink documentId={r.documentId as Id<"documents">} />
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// Map a findingType to the confidence field path the LLM emits for that field.
// Returns null for findings without a single canonical field (e.g. missing_required_documents).
function confidenceFieldPathFor(findingType: string): string | null {
  switch (findingType) {
    case "price_mismatch":
    case "price_amended":
      return "financial.purchasePrice"
    case "title_company_change":
    case "title_company_set":
      return "titleCompany.name"
    case "earnest_money_refundability_change":
      return "financial.earnestMoney.refundable"
    case "closing_date_mismatch":
      return "dates.closingDate"
    case "financing_window_change":
      return "dates.financingApprovalDays"
    case "party_name_mismatch":
      // No index hint per row — fall back to a per-row lookup pattern.
      return "parties.legalName"
    case "party_capacity_mismatch":
      return "parties.capacity"
    default:
      return null
  }
}

// Look up the LLM's confidence for the given field path on this document.
// Returns undefined when no entry — caller treats that as "fully confident".
// Also accepts path matches that include a `parties[N]` index, since the LLM
// emits indexed paths but findingType maps to the unindexed form.
function lookupConfidence(
  conf: Record<string, number> | undefined,
  fieldPath: string | null,
): number | undefined {
  if (!conf || !fieldPath) return undefined
  if (fieldPath in conf) return conf[fieldPath]
  // Match indexed variants: e.g. fieldPath = "parties.legalName"
  // → match any "parties[<n>].legalName" entry, take the min (most cautious).
  const [head, ...rest] = fieldPath.split(".")
  if (rest.length === 0) return undefined
  const tail = rest.join(".")
  const prefix = `${head}[`
  const matches: number[] = []
  for (const [k, v] of Object.entries(conf)) {
    if (k.startsWith(prefix) && k.endsWith(`].${tail}`)) {
      matches.push(v)
    }
  }
  if (matches.length === 0) return undefined
  return Math.min(...matches)
}

function ConfidenceChip({ value }: { value?: number }) {
  if (value === undefined) {
    return (
      <span
        className="rounded-sm bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-900"
        title="No confidence reported — treated as fully confident."
      >
        high
      </span>
    )
  }
  const pct = Math.round(value * 100)
  const cls =
    value >= 0.85
      ? "bg-emerald-100 text-emerald-900"
      : value >= 0.65
        ? "bg-amber-100 text-amber-900"
        : "bg-rose-100 text-rose-900"
  const label =
    value >= 0.85 ? "high" : value >= 0.65 ? "medium" : "low"
  return (
    <span
      className={`rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}
      title={`LLM-reported confidence: ${pct}%`}
    >
      {label} · {pct}%
    </span>
  )
}

function DocLink({ documentId }: { documentId: Id<"documents"> }) {
  const url = useQuery(convexQuery(api.files.documentUrl, { documentId }))
  if (!url.data) {
    return <span className="text-muted-foreground text-[10px]">…</span>
  }
  return (
    <a
      href={url.data}
      target="_blank"
      rel="noreferrer"
      className="text-[10px] underline"
    >
      open
    </a>
  )
}

const DOC_TYPES = [
  { code: "deed", label: "Deed" },
  { code: "mortgage", label: "Mortgage" },
  { code: "release", label: "Release" },
  { code: "assignment", label: "Assignment" },
  { code: "deed_of_trust", label: "Deed of trust" },
] as const

type DocType = (typeof DOC_TYPES)[number]["code"]

function PropertyDetailsPanel({
  fileId,
  file,
}: {
  fileId: Id<"files">
  file: Doc<"files">
}) {
  const update = useConvexMutation(api.files.update)
  const [edit, setEdit] = useState(false)
  const [transactionType, setTransactionType] = useState(file.transactionType)
  const [propertyApn, setPropertyApn] = useState(file.propertyApn ?? "")
  const [line1, setLine1] = useState(file.propertyAddress?.line1 ?? "")
  const [line2, setLine2] = useState(file.propertyAddress?.line2 ?? "")
  const [city, setCity] = useState(file.propertyAddress?.city ?? "")
  const [stateCode, setStateCode] = useState(
    file.propertyAddress?.state ?? file.stateCode,
  )
  const [zip, setZip] = useState(file.propertyAddress?.zip ?? "")
  const [targetCloseDate, setTargetCloseDate] = useState(
    file.targetCloseDate
      ? new Date(file.targetCloseDate).toISOString().slice(0, 10)
      : "",
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      const addrFilled =
        line1.trim() && city.trim() && stateCode.trim() && zip.trim()
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
      })
      setEdit(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg.replace(/^.*ConvexError:\s*/, ""))
    } finally {
      setPending(false)
    }
  }

  const addr = file.propertyAddress
  const addrLine = addr
    ? `${addr.line1}${addr.line2 ? `, ${addr.line2}` : ""}, ${addr.city}, ${addr.state} ${addr.zip}`
    : null

  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between">
        <div>
          <CardTitle>Property details</CardTitle>
          <CardDescription>
            Address, APN, target close, and transaction type.
          </CardDescription>
        </div>
        <Button variant="outline" onClick={() => setEdit(!edit)}>
          {edit ? "Cancel" : "Edit"}
        </Button>
      </CardHeader>
      <CardContent>
        {edit ? (
          <form onSubmit={onSave} className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="pd-tx" className="text-muted-foreground text-xs">
                  Transaction type
                </Label>
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
              </div>
              <div className="flex flex-col gap-1">
                <Label
                  htmlFor="pd-target"
                  className="text-muted-foreground text-xs"
                >
                  Target close
                </Label>
                <Input
                  id="pd-target"
                  type="date"
                  value={targetCloseDate}
                  onChange={(e) => setTargetCloseDate(e.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="pd-apn" className="text-muted-foreground text-xs">
                APN
              </Label>
              <Input
                id="pd-apn"
                value={propertyApn}
                onChange={(e) => setPropertyApn(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="pd-line1"
                className="text-muted-foreground text-xs"
              >
                Address line 1
              </Label>
              <Input
                id="pd-line1"
                value={line1}
                onChange={(e) => setLine1(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="pd-line2"
                className="text-muted-foreground text-xs"
              >
                Address line 2
              </Label>
              <Input
                id="pd-line2"
                value={line2}
                onChange={(e) => setLine2(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col gap-1">
                <Label
                  htmlFor="pd-city"
                  className="text-muted-foreground text-xs"
                >
                  City
                </Label>
                <Input
                  id="pd-city"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label
                  htmlFor="pd-state"
                  className="text-muted-foreground text-xs"
                >
                  State
                </Label>
                <Input
                  id="pd-state"
                  value={stateCode}
                  onChange={(e) => setStateCode(e.target.value)}
                  maxLength={2}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label
                  htmlFor="pd-zip"
                  className="text-muted-foreground text-xs"
                >
                  ZIP
                </Label>
                <Input
                  id="pd-zip"
                  value={zip}
                  onChange={(e) => setZip(e.target.value)}
                />
              </div>
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
            <div className="flex justify-end">
              <Button type="submit" disabled={pending}>
                {pending ? "Saving..." : "Save"}
              </Button>
            </div>
          </form>
        ) : (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground text-xs">Transaction</dt>
            <dd>{file.transactionType}</dd>
            <dt className="text-muted-foreground text-xs">APN</dt>
            <dd>{file.propertyApn || "—"}</dd>
            <dt className="text-muted-foreground text-xs">Address</dt>
            <dd>{addrLine ?? "—"}</dd>
            <dt className="text-muted-foreground text-xs">Target close</dt>
            <dd>
              {file.targetCloseDate
                ? new Date(file.targetCloseDate).toLocaleDateString()
                : "—"}
            </dd>
          </dl>
        )}
      </CardContent>
    </Card>
  )
}

function RulesPanel({ fileId }: { fileId: Id<"files"> }) {
  const [docType, setDocType] = useState<DocType>("deed")
  const rule = useQuery(
    convexQuery(api.rules.resolveForFile, { fileId, docType }),
  )

  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between">
        <div>
          <CardTitle>Recording rules</CardTitle>
          <CardDescription>
            Resolved against the file's county at the file's openedAt.
          </CardDescription>
        </div>
        <Select
          value={docType}
          onValueChange={(v) => setDocType(v as DocType)}
        >
          <SelectTrigger size="sm">
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
      </CardHeader>
      <CardContent>
        {rule.isLoading ? (
          <p className="text-muted-foreground text-sm">Loading rules...</p>
        ) : !rule.data ? (
          <div className="rounded-md border border-[#c9652e]/40 bg-[#fde9dc]/60 p-3 text-sm text-[#a4501f]">
            Rules not configured for this county and document type. Closings can
            proceed but expect manual handling for recording requirements.
          </div>
        ) : (
          <RuleCard rule={rule.data} />
        )}
      </CardContent>
    </Card>
  )
}

function RuleCard({ rule }: { rule: Doc<"countyRecordingRules"> }) {
  const r = rule.rules
  const fees = r.feeSchedule as
    | { firstPage?: number; additionalPage?: number; salesDisclosureFee?: number }
    | undefined
  const sig = r.signaturePageRequirements as
    | {
        notarized?: boolean
        witnessRequired?: boolean
        printedNameBeneathSignature?: boolean
      }
    | undefined
  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="text-muted-foreground mb-2 text-xs">
        v{rule.version} · effective from{" "}
        {new Date(rule.effectiveFrom).toLocaleDateString()}
        {rule.effectiveTo
          ? ` until ${new Date(rule.effectiveTo).toLocaleDateString()}`
          : ""}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        <dt className="text-muted-foreground text-xs">Page size</dt>
        <dd>{r.pageSize ?? "—"}</dd>
        <dt className="text-muted-foreground text-xs">Margins (in)</dt>
        <dd>
          {r.margins
            ? `${r.margins.top}/${r.margins.right}/${r.margins.bottom}/${r.margins.left}`
            : "—"}
        </dd>
        <dt className="text-muted-foreground text-xs">Required exhibits</dt>
        <dd>
          {r.requiredExhibits.length > 0
            ? r.requiredExhibits.join(", ")
            : "none"}
        </dd>
        <dt className="text-muted-foreground text-xs">Fees</dt>
        <dd>
          {fees?.firstPage !== undefined
            ? `$${fees.firstPage} first / $${fees.additionalPage ?? 0} ea.`
            : "—"}
          {fees?.salesDisclosureFee
            ? ` · SDF $${fees.salesDisclosureFee}`
            : ""}
        </dd>
        <dt className="text-muted-foreground text-xs">Signatures</dt>
        <dd>
          {sig?.notarized ? "notarized" : "—"}
          {sig?.witnessRequired ? ", witness required" : ""}
          {sig?.printedNameBeneathSignature ? ", printed name" : ""}
        </dd>
      </dl>
    </div>
  )
}

function PartiesPanel({
  fileId,
  parties,
}: {
  fileId: Id<"files">
  parties: ReadonlyArray<{
    fileParty: { _id: string; role: string; capacity?: string }
    party: {
      _id: string
      legalName: string
      partyType: string
      einOrSsnToken?: string
    }
  }>
}) {
  const addParty = useConvexMutation(api.files.addParty)
  const [show, setShow] = useState(false)
  const [legalName, setLegalName] = useState("")
  const [role, setRole] = useState("buyer")
  const [partyType, setPartyType] = useState<
    "person" | "entity" | "trust" | "estate"
  >("person")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      await addParty({ fileId, legalName, role, partyType })
      setShow(false)
      setLegalName("")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg.replace(/^.*ConvexError:\s*/, ""))
    } finally {
      setPending(false)
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between">
        <div>
          <CardTitle>Parties</CardTitle>
          <CardDescription>
            Vesting + signers. NPI is gated by the canViewNpi flag.
          </CardDescription>
        </div>
        <Button variant="outline" onClick={() => setShow(!show)}>
          {show ? "Cancel" : "Add party"}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {show && (
          <form
            onSubmit={onSubmit}
            className="flex flex-col gap-2 rounded-md border border-border/60 p-3"
          >
            <Input
              placeholder="Legal name"
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              required
            />
            <div className="grid grid-cols-2 gap-2">
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
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
            <Button type="submit" disabled={pending}>
              {pending ? "Adding..." : "Add"}
            </Button>
          </form>
        )}

        {parties.length === 0 ? (
          <div className="text-muted-foreground rounded-md border border-dashed border-border/60 p-3 text-sm">
            No parties yet.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {parties.map(({ fileParty, party }) => (
              <li
                key={fileParty._id}
                className="flex flex-col gap-2 rounded-md border border-border/60 p-3 text-sm"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{party.legalName}</div>
                    <div className="text-muted-foreground text-xs">
                      {party.partyType} · {fileParty.role}
                      {fileParty.capacity ? `, ${fileParty.capacity}` : ""}
                    </div>
                  </div>
                </div>
                <NpiCell
                  fileId={fileId}
                  partyId={party._id as Id<"parties">}
                  token={party.einOrSsnToken}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function NpiCell({
  fileId,
  partyId,
  token,
}: {
  fileId: Id<"files">
  partyId: Id<"parties">
  token?: string
}) {
  const issue = useConvexMutation(api.secrets.issue)
  const reveal = useConvexMutation(api.secrets.reveal)
  const setSecretToken = useConvexMutation(api.parties.setSecretToken)

  const [show, setShow] = useState(false)
  const [fieldKind, setFieldKind] = useState<"ssn" | "ein" | "account" | "dob">(
    "ssn",
  )
  const [plaintext, setPlaintext] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<string | null>(null)

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { token: t } = await issue({ fieldKind, plaintext })
      await setSecretToken({ partyId, token: t })
      setShow(false)
      setPlaintext("")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg.replace(/^.*ConvexError:\s*/, ""))
    } finally {
      setBusy(false)
    }
  }

  const onReveal = async () => {
    if (!token) return
    setBusy(true)
    setError(null)
    try {
      const r = await reveal({ token, fileId, purpose: "file_detail_view" })
      setRevealed(r.plaintext)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg.replace(/^.*ConvexError:\s*/, ""))
    } finally {
      setBusy(false)
    }
  }

  if (!token) {
    return (
      <div>
        {show ? (
          <form onSubmit={onAdd} className="flex flex-wrap items-center gap-2">
            <Select
              value={fieldKind}
              onValueChange={(v) =>
                setFieldKind(v as "ssn" | "ein" | "account" | "dob")
              }
            >
              <SelectTrigger size="sm">
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
              className="h-8 max-w-[12rem] text-xs"
              value={plaintext}
              onChange={(e) => setPlaintext(e.target.value)}
              required
            />
            <Button type="submit" variant="outline" size="sm" disabled={busy}>
              {busy ? "Saving..." : "Save"}
            </Button>
            <Button
              type="button"
              variant="link"
              size="xs"
              className="text-muted-foreground"
              onClick={() => setShow(false)}
            >
              cancel
            </Button>
            {error && (
              <span className="text-xs text-red-600">{error}</span>
            )}
          </form>
        ) : (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="text-muted-foreground"
            onClick={() => setShow(true)}
          >
            + Add SSN / EIN / Account
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground text-xs">NPI on file:</span>
      <code className="rounded bg-muted px-2 py-0.5 font-mono text-xs">
        {revealed ?? "••••••••"}
      </code>
      {revealed ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="text-muted-foreground"
          onClick={() => setRevealed(null)}
        >
          hide
        </Button>
      ) : (
        <Button
          type="button"
          variant="link"
          size="xs"
          onClick={onReveal}
          disabled={busy}
        >
          {busy ? "..." : "reveal"}
        </Button>
      )}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  )
}

function DocumentsPanel({
  fileId,
  documents,
}: {
  fileId: Id<"files">
  documents: ReadonlyArray<{
    _id: string
    title?: string
    docType: string
    sizeBytes?: number
    uploadedAt: number
  }>
}) {
  const generateUploadUrl = useConvexMutation(api.files.generateUploadUrl)
  const recordDocument = useConvexMutation(api.files.recordDocument)
  const [docType, setDocType] = useState("purchase_agreement")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setBusy(true)
    setError(null)
    try {
      const uploadUrl = await generateUploadUrl({})
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": f.type },
        body: f,
      })
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
      const { storageId } = (await res.json()) as { storageId: string }
      await recordDocument({
        fileId,
        storageId: storageId as Id<"_storage">,
        docType,
        title: f.name,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      e.target.value = ""
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between">
        <div>
          <CardTitle>Documents</CardTitle>
          <CardDescription>
            Upload PA, counter offers, commitments, etc. Click Extract to feed
            reconciliation.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Select value={docType} onValueChange={setDocType}>
            <SelectTrigger size="sm">
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
          <Button asChild variant="outline" disabled={busy}>
            <label className="cursor-pointer">
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
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <p className="text-destructive text-sm">{error}</p>}

        {documents.length === 0 ? (
          <div className="text-muted-foreground rounded-md border border-dashed border-border/60 p-3 text-sm">
            No documents yet.
          </div>
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
      </CardContent>
    </Card>
  )
}

function DocumentRow({
  documentId,
  title,
  docType,
  sizeBytes,
  uploadedAt,
}: {
  documentId: Id<"documents">
  title?: string
  docType: string
  sizeBytes?: number
  uploadedAt: number
}) {
  const ext = useQuery(
    convexQuery(api.extractions.getForDocument, { documentId }),
  )
  const runExtraction = useConvexMutation(api.extractions.run)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onExtract = async () => {
    setBusy(true)
    setErr(null)
    try {
      await runExtraction({ documentId })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const status = ext.data?.status
  const label =
    status === "succeeded"
      ? "Re-extract"
      : status === "running" || status === "pending"
        ? "Extracting..."
        : status === "failed"
          ? "Retry extract"
          : "Extract"

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
      <div className="min-w-0">
        <div className="truncate font-medium">{title ?? docType}</div>
        <div className="text-muted-foreground text-xs">
          {docType} ·{" "}
          {sizeBytes !== undefined ? `${(sizeBytes / 1024).toFixed(1)} KB · ` : ""}
          {new Date(uploadedAt).toLocaleString()}
          {status && (
            <>
              {" · "}
              <span
                className={
                  status === "succeeded"
                    ? "text-green-700"
                    : status === "failed"
                      ? "text-red-600"
                      : "text-amber-700"
                }
              >
                extraction: {status}
              </span>
            </>
          )}
        </div>
        {err && <div className="text-xs text-red-600">{err}</div>}
        {ext.data?.errorMessage && (
          <div className="text-xs text-red-600">
            {ext.data.errorMessage}
          </div>
        )}
      </div>
      <Button
        variant="outline"
        onClick={onExtract}
        disabled={busy || status === "running" || status === "pending"}
      >
        {label}
      </Button>
    </li>
  )
}

function AuditPanel({
  events,
}: {
  events: ReadonlyArray<{
    _id: string
    action: string
    occurredAt: number
    metadata?: unknown
  }>
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>Tenant-scoped audit feed for this file.</CardDescription>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <div className="text-muted-foreground rounded-md border border-dashed border-border/60 p-3 text-sm">
            No activity yet.
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {events.map((e) => (
              <li
                key={e._id}
                className="rounded-md border border-border/60 p-3 text-sm"
              >
                <div className="font-medium">{e.action}</div>
                <div className="text-muted-foreground text-xs">
                  {new Date(e.occurredAt).toLocaleString()}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
