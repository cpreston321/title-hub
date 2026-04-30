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

        <FindingsPanel fileId={id} />
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

function FindingsPanel({ fileId }: { fileId: Id<"files"> }) {
  const findings = useQuery(
    convexQuery(api.reconciliation.listForFile, { fileId }),
  )
  const reconcile = useConvexMutation(api.reconciliation.runForFile)
  const setStatus = useConvexMutation(api.reconciliation.setStatus)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [counts, setCounts] = useState<{
    info: number
    warn: number
    block: number
  } | null>(null)

  const onReconcile = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await reconcile({ fileId })
      setCounts(r.counts)
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

  const list = findings.data ?? []
  const open = list.filter((f) => f.status === "open")
  const closed = list.filter((f) => f.status !== "open")

  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between">
        <div>
          <CardTitle>Priority queue</CardTitle>
          <CardDescription>
            {counts
              ? `${counts.block} block · ${counts.warn} warn · ${counts.info} info`
              : "Reconciliation findings — run after uploading documents."}
          </CardDescription>
        </div>
        <Button onClick={onReconcile} disabled={busy}>
          {busy ? "Running..." : "Reconcile"}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <p className="text-destructive text-sm">{error}</p>}

      {open.length === 0 ? (
        <div className="text-muted-foreground rounded-md border border-dashed border-border/60 p-3 text-sm">
          No open findings. Run reconcile after uploading documents and
          extracting them.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {open.map((f) => (
            <li
              key={f._id}
              className={`rounded-md border p-3 text-sm ${
                SEVERITY_STYLES[f.severity] ?? ""
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs uppercase tracking-wide">
                  {f.severity} · {f.findingType}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="text-xs underline"
                    onClick={() =>
                      onAck(f._id as Id<"reconciliationFindings">, "acknowledged")
                    }
                  >
                    ack
                  </button>
                  <button
                    type="button"
                    className="text-xs underline"
                    onClick={() =>
                      onAck(f._id as Id<"reconciliationFindings">, "resolved")
                    }
                  >
                    resolve
                  </button>
                  <button
                    type="button"
                    className="text-xs underline"
                    onClick={() =>
                      onAck(f._id as Id<"reconciliationFindings">, "dismissed")
                    }
                  >
                    dismiss
                  </button>
                </div>
              </div>
              <p className="mt-1">{f.message}</p>
            </li>
          ))}
        </ul>
      )}

      {closed.length > 0 && (
        <details className="text-muted-foreground text-xs">
          <summary className="cursor-pointer">
            {closed.length} closed finding{closed.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 flex flex-col gap-1">
            {closed.map((f) => (
              <li key={f._id} className="rounded border p-2">
                {f.status} · {f.findingType} · {f.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      </CardContent>
    </Card>
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
        <select
          value={docType}
          onChange={(e) => setDocType(e.target.value as DocType)}
          className="border-input bg-background h-8 rounded-md border px-2 text-xs"
        >
          {DOC_TYPES.map((d) => (
            <option key={d.code} value={d.code}>
              {d.label}
            </option>
          ))}
        </select>
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
              <select
                className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                value={partyType}
                onChange={(e) =>
                  setPartyType(
                    e.target.value as "person" | "entity" | "trust" | "estate",
                  )
                }
              >
                <option value="person">Person</option>
                <option value="entity">Entity</option>
                <option value="trust">Trust</option>
                <option value="estate">Estate</option>
              </select>
              <select
                className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                <option value="buyer">Buyer</option>
                <option value="seller">Seller</option>
                <option value="lender">Lender</option>
                <option value="borrower">Borrower</option>
                <option value="trustee">Trustee</option>
                <option value="signer">Signer</option>
              </select>
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
            <select
              value={fieldKind}
              onChange={(e) =>
                setFieldKind(
                  e.target.value as "ssn" | "ein" | "account" | "dob",
                )
              }
              className="rounded border px-2 py-1 text-xs"
            >
              <option value="ssn">SSN</option>
              <option value="ein">EIN</option>
              <option value="account">Account</option>
              <option value="dob">DOB</option>
            </select>
            <input
              type="text"
              autoComplete="off"
              placeholder="123-45-6789"
              className="rounded border px-2 py-1 text-xs"
              value={plaintext}
              onChange={(e) => setPlaintext(e.target.value)}
              required
            />
            <Button type="submit" variant="outline" disabled={busy}>
              {busy ? "Saving..." : "Save"}
            </Button>
            <button
              type="button"
              onClick={() => setShow(false)}
              className="text-muted-foreground text-xs underline"
            >
              cancel
            </button>
            {error && (
              <span className="text-xs text-red-600">{error}</span>
            )}
          </form>
        ) : (
          <button
            type="button"
            className="text-muted-foreground text-xs underline"
            onClick={() => setShow(true)}
          >
            + Add SSN / EIN / Account
          </button>
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
        <button
          type="button"
          onClick={() => setRevealed(null)}
          className="text-muted-foreground text-xs underline"
        >
          hide
        </button>
      ) : (
        <button
          type="button"
          onClick={onReveal}
          disabled={busy}
          className="text-xs underline"
        >
          {busy ? "..." : "reveal"}
        </button>
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
          <select
            className="border-input bg-background h-8 rounded-md border px-2 text-xs"
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
          >
            <option value="purchase_agreement">Purchase agreement</option>
            <option value="counter_offer">Counter offer</option>
            <option value="title_search">Title search</option>
            <option value="commitment">Commitment</option>
            <option value="closing_disclosure">Closing disclosure</option>
            <option value="other">Other</option>
          </select>
          <Button asChild variant="outline" disabled={busy}>
            <label className="cursor-pointer">
              {busy ? "Uploading..." : "Upload"}
              <input
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
