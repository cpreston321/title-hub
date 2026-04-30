import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { convexQuery, useConvexMutation } from "@convex-dev/react-query"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { AppShell } from "@/components/app-shell"
import { api } from "../../../convex/_generated/api"
import type { Id } from "../../../convex/_generated/dataModel"

export const Route = createFileRoute("/admin/rules")({
  beforeLoad: ({ context }) => {
    if (!(context as { isAuthenticated?: boolean }).isAuthenticated) {
      throw redirect({ to: "/signin" })
    }
  },
  component: RulesAdminPage,
})

const DOC_TYPES = [
  "deed",
  "mortgage",
  "release",
  "assignment",
  "deed_of_trust",
] as const
type DocType = (typeof DOC_TYPES)[number]

function RulesAdminPage() {
  const current = useQuery(convexQuery(api.tenants.current, {}))
  const counties = useQuery(convexQuery(api.seed.listIndianaCounties, {}))
  const seedPilot = useConvexMutation(api.rules.seedPilotRules)
  const [seeding, setSeeding] = useState(false)
  const [seedMsg, setSeedMsg] = useState<string | null>(null)
  const [countyId, setCountyId] = useState<Id<"counties"> | "">("")

  if (current.isLoading) {
    return (
      <AppShell isAuthenticated title="Recording rules">
        <p className="text-muted-foreground text-sm">Loading...</p>
      </AppShell>
    )
  }
  if (current.error) {
    return (
      <AppShell isAuthenticated title="Recording rules">
        <p className="text-destructive text-sm">{current.error.message}</p>
      </AppShell>
    )
  }
  if (current.data?.role !== "owner") {
    return (
      <AppShell isAuthenticated title="Recording rules">
        <Card className="mx-auto max-w-xl">
          <CardHeader>
            <CardTitle>No access</CardTitle>
            <CardDescription>
              Recording rules require the owner role.
            </CardDescription>
          </CardHeader>
        </Card>
      </AppShell>
    )
  }

  const onSeedPilot = async () => {
    setSeeding(true)
    setSeedMsg(null)
    try {
      const r = await seedPilot({})
      setSeedMsg(`Inserted ${r.rulesInserted} rule(s).`)
    } catch (err) {
      setSeedMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setSeeding(false)
    }
  }

  const countyList = counties.data ?? []

  return (
    <AppShell
      isAuthenticated
      title="Recording rules"
      subtitle="Versioned per county + document type. New versions supersede the previous one at their effective date."
      actions={
        <>
          <Button asChild variant="outline" size="sm">
            <Link to="/admin">← Admin</Link>
          </Button>
          <Button variant="outline" onClick={onSeedPilot} disabled={seeding}>
            {seeding ? "Seeding..." : "Seed Marion + Hamilton defaults"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {seedMsg && (
          <p className="text-muted-foreground text-sm">{seedMsg}</p>
        )}

        <Card>
          <CardHeader>
            <CardTitle>County</CardTitle>
            <CardDescription>
              Pick a county to browse versioned rules.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <select
              value={countyId}
              onChange={(e) => setCountyId(e.target.value as Id<"counties">)}
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
            >
              <option value="">Select a county...</option>
              {countyList.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.name} County, {c.stateCode}
                </option>
              ))}
            </select>
          </CardContent>
        </Card>

      {countyId && (
        <CountyRulesPanel
          countyId={countyId as Id<"counties">}
          authoringMemberRole={current.data.role}
        />
      )}
      </div>
    </AppShell>
  )
}

function CountyRulesPanel({
  countyId,
  authoringMemberRole,
}: {
  countyId: Id<"counties">
  authoringMemberRole: string
}) {
  const list = useQuery(convexQuery(api.rules.listForCounty, { countyId }))
  const [docType, setDocType] = useState<DocType>("deed")
  const [showForm, setShowForm] = useState(false)

  const grouped = useMemo(() => {
    const out: Record<string, typeof list.data> = {}
    for (const r of list.data ?? []) {
      ;(out[r.docType] ??= [] as never)
      out[r.docType]!.push(r)
    }
    return out
  }, [list.data])

  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between">
        <div>
          <CardTitle>Rules</CardTitle>
          <CardDescription>
            Browse versions per doc type. Propose a new one to supersede.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={docType}
            onChange={(e) => setDocType(e.target.value as DocType)}
            className="border-input bg-background h-8 rounded-md border px-2 text-xs"
          >
            {DOC_TYPES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          {authoringMemberRole === "owner" && (
            <Button onClick={() => setShowForm(!showForm)}>
              {showForm ? "Cancel" : "Propose new version"}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
      {showForm && (
        <PublishRuleForm
          countyId={countyId}
          docType={docType}
          supersedes={
            (grouped[docType] ?? []).find((r) => !r.effectiveTo)?._id
          }
          onDone={() => setShowForm(false)}
        />
      )}

      {DOC_TYPES.map((d) => {
          const versions = grouped[d] ?? []
          return (
            <div key={d}>
              <div className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">
                {d}
              </div>
              {versions.length === 0 ? (
                <div className="rounded-md border p-3 text-sm text-muted-foreground">
                  No versions yet.
                </div>
              ) : (
                <ul className="flex flex-col gap-1">
                  {versions.map((v) => (
                    <li
                      key={v._id}
                      className="rounded-md border p-3 text-sm"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">v{v.version}</span>
                        <span className="text-muted-foreground text-xs">
                          {new Date(v.effectiveFrom).toLocaleDateString()}
                          {v.effectiveTo
                            ? ` → ${new Date(v.effectiveTo).toLocaleDateString()}`
                            : " · active"}
                        </span>
                      </div>
                      <div className="text-muted-foreground mt-1 text-xs">
                        {v.rules.pageSize ?? "—"} ·{" "}
                        {v.rules.requiredExhibits.length > 0
                          ? v.rules.requiredExhibits.join(", ")
                          : "no exhibits"}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}


function PublishRuleForm({
  countyId,
  docType,
  supersedes,
  onDone,
}: {
  countyId: Id<"counties">
  docType: DocType
  supersedes?: Id<"countyRecordingRules">
  onDone: () => void
}) {
  const publish = useConvexMutation(api.rules.publishRule)
  const [pageSize, setPageSize] = useState("letter")
  const [marginTop, setMarginTop] = useState(2)
  const [marginBottom, setMarginBottom] = useState(1)
  const [marginLeft, setMarginLeft] = useState(1)
  const [marginRight, setMarginRight] = useState(1)
  const [exhibits, setExhibits] = useState("legal_description")
  const [firstPage, setFirstPage] = useState(25)
  const [additionalPage, setAdditionalPage] = useState(5)
  const [salesDisclosureFee, setSalesDisclosureFee] = useState(0)
  const [effectiveDate, setEffectiveDate] = useState(
    new Date().toISOString().slice(0, 10),
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      const effectiveFrom = new Date(effectiveDate).getTime()
      await publish({
        countyId,
        docType,
        effectiveFrom,
        supersedes,
        rules: {
          pageSize,
          margins: {
            top: marginTop,
            bottom: marginBottom,
            left: marginLeft,
            right: marginRight,
          },
          requiredExhibits: exhibits
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          feeSchedule: {
            firstPage,
            additionalPage,
            salesDisclosureFee,
          },
          signaturePageRequirements: {
            notarized: true,
            witnessRequired: false,
            printedNameBeneathSignature: true,
          },
          notaryRequirements: {
            sealRequired: true,
            commissionExpirationStatement: true,
          },
        },
      })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="grid gap-2 rounded-md border p-3 text-sm"
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">Page size</span>
          <input
            className="rounded border px-2 py-1 text-sm"
            value={pageSize}
            onChange={(e) => setPageSize(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">Effective date</span>
          <input
            type="date"
            className="rounded border px-2 py-1 text-sm"
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
            required
          />
        </label>
      </div>

      <fieldset className="grid grid-cols-4 gap-2 rounded border p-2">
        <legend className="text-muted-foreground text-xs">Margins (in)</legend>
        <NumberCell label="top" value={marginTop} onChange={setMarginTop} />
        <NumberCell
          label="bottom"
          value={marginBottom}
          onChange={setMarginBottom}
        />
        <NumberCell label="left" value={marginLeft} onChange={setMarginLeft} />
        <NumberCell
          label="right"
          value={marginRight}
          onChange={setMarginRight}
        />
      </fieldset>

      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">
          Required exhibits (comma separated)
        </span>
        <input
          className="rounded border px-2 py-1 text-sm"
          value={exhibits}
          onChange={(e) => setExhibits(e.target.value)}
        />
      </label>

      <fieldset className="grid grid-cols-3 gap-2 rounded border p-2">
        <legend className="text-muted-foreground text-xs">
          Fee schedule ($)
        </legend>
        <NumberCell label="first page" value={firstPage} onChange={setFirstPage} />
        <NumberCell
          label="ea. addl"
          value={additionalPage}
          onChange={setAdditionalPage}
        />
        <NumberCell
          label="SDF"
          value={salesDisclosureFee}
          onChange={setSalesDisclosureFee}
        />
      </fieldset>

      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Publishing..." : "Publish version"}
        </Button>
      </div>
    </form>
  )
}

function NumberCell({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (n: number) => void
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <input
        type="number"
        step="0.5"
        min={0}
        className="rounded border px-2 py-1 text-sm"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}
