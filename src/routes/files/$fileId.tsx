import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { convexQuery, useConvexMutation } from "@convex-dev/react-query"
import { Button } from "@/components/ui/button"
import { api } from "../../../convex/_generated/api"
import type { Id } from "../../../convex/_generated/dataModel"

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
      <div className="p-6 text-sm text-red-600">
        Error: {detail.error.message}
      </div>
    )
  }

  if (detail.isLoading || !detail.data) {
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>
  }

  const { file, county, parties, documents } = detail.data
  const events = audit.data ?? []

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <header>
        <Link to="/files" className="text-xs text-muted-foreground underline">
          ← Files
        </Link>
        <h1 className="mt-2 text-xl font-semibold">{file.fileNumber}</h1>
        <div className="text-muted-foreground text-sm">
          {file.transactionType} · {county?.name} County, {file.stateCode}{" "}
          · status: {file.status}
        </div>
      </header>

      <PartiesPanel fileId={id} parties={parties} />
      <DocumentsPanel fileId={id} documents={documents} />
      <AuditPanel events={events} />
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
    party: { _id: string; legalName: string; partyType: string }
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
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-medium">Parties</h2>
        <Button variant="outline" onClick={() => setShow(!show)}>
          {show ? "Cancel" : "Add party"}
        </Button>
      </div>

      {show && (
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-2 rounded-md border p-3"
        >
          <input
            className="rounded border px-3 py-2 text-sm"
            placeholder="Legal name"
            value={legalName}
            onChange={(e) => setLegalName(e.target.value)}
            required
          />
          <div className="grid grid-cols-2 gap-2">
            <select
              className="rounded border px-3 py-2 text-sm"
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
              className="rounded border px-3 py-2 text-sm"
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
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" disabled={pending}>
            {pending ? "Adding..." : "Add"}
          </Button>
        </form>
      )}

      {parties.length === 0 ? (
        <div className="rounded-md border p-3 text-sm text-muted-foreground">
          No parties yet.
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {parties.map(({ fileParty, party }) => (
            <li
              key={fileParty._id}
              className="flex items-center justify-between rounded-md border p-3 text-sm"
            >
              <div>
                <div className="font-medium">{party.legalName}</div>
                <div className="text-muted-foreground text-xs">
                  {party.partyType} ·{" "}
                  {fileParty.role}
                  {fileParty.capacity ? `, ${fileParty.capacity}` : ""}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
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
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-medium">Documents</h2>
        <div className="flex items-center gap-2">
          <select
            className="rounded border px-2 py-1 text-sm"
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
          <label className="cursor-pointer rounded-4xl border px-3 py-2 text-sm">
            {busy ? "Uploading..." : "Upload"}
            <input
              type="file"
              className="hidden"
              onChange={onUpload}
              disabled={busy}
            />
          </label>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {documents.length === 0 ? (
        <div className="rounded-md border p-3 text-sm text-muted-foreground">
          No documents yet.
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {documents.map((d) => (
            <li
              key={d._id}
              className="flex items-center justify-between rounded-md border p-3 text-sm"
            >
              <div>
                <div className="font-medium">{d.title ?? d.docType}</div>
                <div className="text-muted-foreground text-xs">
                  {d.docType} ·{" "}
                  {d.sizeBytes !== undefined
                    ? `${(d.sizeBytes / 1024).toFixed(1)} KB · `
                    : ""}
                  {new Date(d.uploadedAt).toLocaleString()}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
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
    <section className="flex flex-col gap-2">
      <h2 className="text-base font-medium">Activity</h2>
      {events.length === 0 ? (
        <div className="rounded-md border p-3 text-sm text-muted-foreground">
          No activity yet.
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {events.map((e) => (
            <li
              key={e._id}
              className="rounded-md border p-3 text-sm"
            >
              <div className="font-medium">{e.action}</div>
              <div className="text-muted-foreground text-xs">
                {new Date(e.occurredAt).toLocaleString()}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
