import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Stamp, X } from 'lucide-react'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AppShell } from '@/components/app-shell'
import { Loading } from '@/components/loading'
import { CountyCombobox } from '@/components/county-combobox'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

export const Route = createFileRoute('/admin/rules')({
  head: () => ({
    meta: [
      { title: 'Recording rules · Title Hub' },
      {
        name: 'description',
        content:
          'Versioned per-county recording rules — page size, margins, fees, and signature requirements.',
      },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!(context as { isAuthenticated?: boolean }).isAuthenticated) {
      throw redirect({ to: '/signin' })
    }
  },
  component: RulesAdminPage,
})

const DOC_TYPES = [
  { id: 'deed', title: 'Deeds', roman: 'I' },
  { id: 'mortgage', title: 'Mortgages', roman: 'II' },
  { id: 'release', title: 'Releases', roman: 'III' },
  { id: 'assignment', title: 'Assignments', roman: 'IV' },
  { id: 'deed_of_trust', title: 'Deeds of Trust', roman: 'V' },
] as const
type DocType = (typeof DOC_TYPES)[number]['id']

function RulesAdminPage() {
  const current = useQuery(convexQuery(api.tenants.current, {}))
  const counties = useQuery(convexQuery(api.seed.listIndianaCounties, {}))
  const seedPilot = useConvexMutation(api.rules.seedPilotRules)
  const [seeding, setSeeding] = useState(false)
  const [seedMsg, setSeedMsg] = useState<string | null>(null)
  const [countyId, setCountyId] = useState<Id<'counties'> | ''>('')

  if (current.isLoading) {
    return (
      <AppShell isAuthenticated title="Recording rules">
        <Loading block size="lg" label="Loading the codex" />
      </AppShell>
    )
  }
  if (current.error) {
    return (
      <AppShell isAuthenticated title="Recording rules">
        <p className="text-sm text-destructive">{current.error.message}</p>
      </AppShell>
    )
  }
  if (current.data?.role !== 'owner') {
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
  const selectedCounty = countyList.find((c) => c._id === countyId)

  return (
    <AppShell
      isAuthenticated
      title="Recording rules"
      subtitle="Versioned per county + document type. New versions supersede the previous one at their effective date."
    >
      <div className="flex flex-col gap-8 pb-12">
        <CodexHeader
          actions={
            <>
              <Button asChild variant="outline" size="sm">
                <Link to="/admin">← Admin</Link>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onSeedPilot}
                disabled={seeding}
              >
                {seeding ? 'Seeding...' : 'Seed Marion + Hamilton'}
              </Button>
            </>
          }
        />

        {seedMsg && (
          <p className="font-numerals rounded-md border border-border/60 bg-card px-3 py-2 text-xs text-muted-foreground">
            {seedMsg}
          </p>
        )}

        <CountyPicker
          countyList={countyList}
          countyId={countyId}
          setCountyId={setCountyId}
          selectedCountyName={
            selectedCounty
              ? `${selectedCounty.name}, ${selectedCounty.stateCode}`
              : null
          }
        />

        {countyId && (
          <CountyRulesPanel
            countyId={countyId as Id<'counties'>}
            authoringMemberRole={current.data.role}
          />
        )}
      </div>
    </AppShell>
  )
}

function CodexHeader({ actions }: { actions?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl leading-[1] font-semibold tracking-tight text-[#40233f] md:text-5xl">
            Recording rules
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Margins, fees, exhibits, notarial requirements — versioned per
            county and document type. New versions supersede the previous one
            on their effective date.
          </p>
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
    </div>
  )
}

function CountyPicker({
  countyList,
  countyId,
  setCountyId,
  selectedCountyName,
}: {
  countyList: ReadonlyArray<{
    _id: Id<'counties'>
    name: string
    stateCode: string
  }>
  countyId: Id<'counties'> | ''
  setCountyId: (id: Id<'counties'>) => void
  selectedCountyName: string | null
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-card/80 shadow-sm ring-1 ring-foreground/5">
      <div className="flex items-center gap-3 border-b border-border/50 bg-[#fdf6e8] px-6 py-3">
        <span className="grid size-7 place-items-center rounded-md border border-[#40233f]/20 bg-card font-display text-xs font-semibold text-[#40233f]">
          I
        </span>
        <div className="text-xs font-medium text-[#b78625]">
          Step one · choose a jurisdiction
        </div>
        {selectedCountyName && (
          <span className="font-numerals ml-auto inline-flex items-center gap-1.5 rounded-full bg-[#e6f3ed] px-2.5 py-1 text-xs text-[#2f5d4b] ring-1 ring-[#3f7c64]/35 ring-inset">
            <span className="size-1 rounded-full bg-[#3f7c64]" />
            browsing {selectedCountyName}
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 px-6 py-5 md:grid-cols-[1fr_auto] md:items-center">
        <div className="min-w-0">
          <CountyCombobox
            counties={countyList}
            value={countyId}
            onChange={setCountyId}
            placeholder="Select a county..."
            className="h-11 text-sm"
          />
        </div>
        <div className="text-xs text-muted-foreground md:text-right">
          {countyList.length > 0
            ? `${countyList.length} counties of record`
            : "Seed a state's counties to begin."}
        </div>
      </div>
    </div>
  )
}

type RuleRow = {
  _id: Id<'countyRecordingRules'>
  docType: string
  version: number
  effectiveFrom: number
  effectiveTo?: number
  rules: {
    pageSize?: string
    margins?: { top: number; bottom: number; left: number; right: number }
    requiredExhibits: string[]
    feeSchedule?: {
      firstPage?: number
      additionalPage?: number
      salesDisclosureFee?: number
    }
  }
}

function CountyRulesPanel({
  countyId,
  authoringMemberRole,
}: {
  countyId: Id<'counties'>
  authoringMemberRole: string
}) {
  const list = useQuery(convexQuery(api.rules.listForCounty, { countyId }))
  const [docType, setDocType] = useState<DocType>('deed')
  const [showForm, setShowForm] = useState(false)

  const grouped = useMemo(() => {
    const out: Record<string, RuleRow[]> = {}
    for (const r of (list.data ?? []) as RuleRow[]) {
      ;(out[r.docType] ??= []).push(r)
    }
    return out
  }, [list.data])

  const isOwner = authoringMemberRole === 'owner'

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border/60 bg-card/60 px-5 py-4 shadow-sm ring-1 ring-foreground/5">
        <div className="flex items-center gap-2 overflow-x-auto">
          {DOC_TYPES.map((d) => {
            const count = (grouped[d.id] ?? []).length
            const active = docType === d.id
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => setDocType(d.id)}
                className={`group/tab flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs transition ${
                  active
                    ? 'border-[#40233f] bg-[#40233f] text-[#f6e8d9] shadow-sm'
                    : 'border-border bg-card text-muted-foreground hover:border-[#40233f]/40 hover:text-[#40233f]'
                }`}
              >
                <span
                  className={`text-xs ${
                    active ? 'text-[#f4d48f]' : 'text-[#b78625]/80'
                  }`}
                >
                  {d.roman}
                </span>
                {d.title}
                <span
                  className={`font-numerals rounded-full px-1.5 text-xs tabular-nums ${
                    active
                      ? 'bg-white/15 text-white/80'
                      : 'bg-muted text-muted-foreground/80'
                  }`}
                >
                  {count}
                </span>
              </button>
            )
          })}
        </div>
        {isOwner && (
          <Button onClick={() => setShowForm((s) => !s)} className="gap-2">
            {showForm ? (
              <>
                <X className="size-4" />
                Cancel amendment
              </>
            ) : (
              <>
                <Stamp className="size-4" />
                Propose new version
              </>
            )}
          </Button>
        )}
      </div>

      {showForm && (
        <PublishRuleForm
          countyId={countyId}
          docType={docType}
          supersedes={(grouped[docType] ?? []).find((r) => !r.effectiveTo)?._id}
          onDone={() => setShowForm(false)}
        />
      )}

      <DocTypePanel
        docType={docType}
        title={DOC_TYPES.find((d) => d.id === docType)!.title}
        roman={DOC_TYPES.find((d) => d.id === docType)!.roman}
        versions={grouped[docType] ?? []}
      />
    </div>
  )
}

function DocTypePanel({
  docType,
  title,
  roman,
  versions,
}: {
  docType: DocType
  title: string
  roman: string
  versions: ReadonlyArray<RuleRow>
}) {
  const sorted = [...versions].sort((a, b) => b.version - a.version)
  return (
    <article className="overflow-hidden rounded-2xl bg-card shadow-md ring-1 ring-foreground/5">
      <header className="flex items-end justify-between border-b border-border/60 px-7 pt-7 pb-5">
        <div>
          <div className="text-xs font-medium text-[#b78625]">
            Article {roman} · {docType}
          </div>
          <h2 className="mt-1.5 font-display text-3xl leading-none font-semibold tracking-tight text-[#40233f]">
            {title}
          </h2>
        </div>
        <div className="font-numerals rounded-md border border-border/60 bg-[#fdf6e8] px-3 py-1.5 text-xs text-[#40233f] tabular-nums">
          {sorted.length} version{sorted.length === 1 ? '' : 's'} of record
        </div>
      </header>

      {sorted.length === 0 ? (
        <div className="px-7 py-16 text-center">
          <div className="text-xl font-semibold text-[#40233f]">
            No versions of record.
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Propose a new amendment to publish the first version.
          </p>
        </div>
      ) : (
        <ol className="relative">
          <div
            aria-hidden
            className="absolute top-0 bottom-0 left-[5.5rem] w-px bg-gradient-to-b from-transparent via-border to-transparent"
          />
          {sorted.map((v, i) => {
            const active = !v.effectiveTo
            return (
              <li
                key={v._id}
                className={`relative grid grid-cols-[5.5rem_auto_1fr] items-start gap-6 px-7 py-6 ${
                  i < sorted.length - 1 ? 'border-b border-border/40' : ''
                } ${active ? 'bg-[#fdf6e8]/60' : ''}`}
              >
                <div className="text-right">
                  <div className="text-xs text-muted-foreground">Version</div>
                  <div
                    className={`font-display text-4xl leading-none font-semibold tabular-nums ${
                      active ? 'text-[#40233f]' : 'text-muted-foreground/70'
                    }`}
                  >
                    {String(v.version).padStart(2, '0')}
                  </div>
                </div>

                <div
                  className={`relative z-10 mt-2 grid size-4 place-items-center rounded-full ${
                    active
                      ? 'bg-[#40233f] ring-4 ring-[#f8eed7]'
                      : 'bg-muted ring-4 ring-card'
                  }`}
                >
                  {active && (
                    <span className="size-1.5 rounded-full bg-[#f4d48f]" />
                  )}
                </div>

                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-3">
                    <div className="font-display text-lg font-semibold tracking-tight text-[#40233f]">
                      Effective{' '}
                      {new Date(v.effectiveFrom).toLocaleDateString('en-US', {
                        dateStyle: 'long',
                      })}
                    </div>
                    {active ? (
                      <span className="font-numerals inline-flex items-center gap-1.5 rounded-full bg-[#e6f3ed] px-2.5 py-0.5 text-xs text-[#2f5d4b] ring-1 ring-[#3f7c64]/35 ring-inset">
                        <span className="size-1 rounded-full bg-[#3f7c64]" />
                        in force
                      </span>
                    ) : (
                      <span className="font-numerals text-xs text-muted-foreground">
                        Superseded{' '}
                        {new Date(v.effectiveTo!).toLocaleDateString()}
                      </span>
                    )}
                  </div>

                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <DataCell
                      label="Page size"
                      value={v.rules.pageSize ?? '—'}
                    />
                    <DataCell
                      label="Margins (TBLR)"
                      value={
                        v.rules.margins
                          ? `${v.rules.margins.top}·${v.rules.margins.bottom}·${v.rules.margins.left}·${v.rules.margins.right}`
                          : '—'
                      }
                    />
                    <DataCell
                      label="First / addl"
                      value={
                        v.rules.feeSchedule
                          ? `$${v.rules.feeSchedule.firstPage ?? 0} / $${v.rules.feeSchedule.additionalPage ?? 0}`
                          : '—'
                      }
                    />
                    <DataCell
                      label="SDF"
                      value={
                        v.rules.feeSchedule?.salesDisclosureFee !== undefined
                          ? `$${v.rules.feeSchedule.salesDisclosureFee}`
                          : '—'
                      }
                    />
                  </div>

                  {v.rules.requiredExhibits.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium text-muted-foreground">
                        Exhibits
                      </span>
                      {v.rules.requiredExhibits.map((ex) => (
                        <span
                          key={ex}
                          className="font-numerals inline-flex items-center rounded-full border border-border bg-card px-2 py-0.5 text-xs text-[#40233f]"
                        >
                          {ex}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </article>
  )
}

function DataCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-card px-3 py-2">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="font-numerals mt-0.5 text-sm text-[#40233f] tabular-nums">
        {value}
      </div>
    </div>
  )
}

function PublishRuleForm({
  countyId,
  docType,
  supersedes,
  onDone,
}: {
  countyId: Id<'counties'>
  docType: DocType
  supersedes?: Id<'countyRecordingRules'>
  onDone: () => void
}) {
  const publish = useConvexMutation(api.rules.publishRule)
  const [pageSize, setPageSize] = useState('letter')
  const [marginTop, setMarginTop] = useState(2)
  const [marginBottom, setMarginBottom] = useState(1)
  const [marginLeft, setMarginLeft] = useState(1)
  const [marginRight, setMarginRight] = useState(1)
  const [exhibits, setExhibits] = useState('legal_description')
  const [firstPage, setFirstPage] = useState(25)
  const [additionalPage, setAdditionalPage] = useState(5)
  const [salesDisclosureFee, setSalesDisclosureFee] = useState(0)
  const [effectiveDate, setEffectiveDate] = useState(
    new Date().toISOString().slice(0, 10)
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
            .split(',')
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

  const docLabel = DOC_TYPES.find((d) => d.id === docType)
  return (
    <form
      onSubmit={onSubmit}
      className="relative overflow-hidden rounded-2xl border border-border/70 bg-card shadow-md ring-1 ring-foreground/5"
    >
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border/60 bg-[#fdf6e8] px-7 py-4">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-md border border-[#40233f]/20 bg-card">
            <Stamp className="size-4 text-[#40233f]" />
          </div>
          <div>
            <div className="text-xs font-medium text-[#b78625]">
              Draft amendment
            </div>
            <div className="font-display text-lg font-semibold tracking-tight text-[#40233f]">
              Article {docLabel?.roman} · {docLabel?.title}
            </div>
          </div>
        </div>
        <div className="rounded-md border border-border/60 bg-card px-3 py-1.5 text-xs text-muted-foreground">
          {supersedes
            ? 'Will supersede the version currently in force'
            : 'First version of record'}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 px-7 py-6 lg:grid-cols-2">
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor="rule-page-size"
              className="text-xs font-medium text-[#40233f]"
            >
              Page size
            </Label>
            <Input
              id="rule-page-size"
              value={pageSize}
              onChange={(e) => setPageSize(e.target.value)}
              className="font-numerals"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor="rule-effective-date"
              className="text-xs font-medium text-[#40233f]"
            >
              Effective date
            </Label>
            <Input
              id="rule-effective-date"
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
              required
              className="font-numerals"
            />
          </div>
        </div>

        <fieldset className="rounded-xl border border-border/60 bg-card/60 p-4">
          <legend className="px-2 text-xs font-medium text-[#40233f]">
            Margins · inches
          </legend>
          <div className="grid grid-cols-4 gap-3">
            <NumberCell label="Top" value={marginTop} onChange={setMarginTop} />
            <NumberCell
              label="Bottom"
              value={marginBottom}
              onChange={setMarginBottom}
            />
            <NumberCell
              label="Left"
              value={marginLeft}
              onChange={setMarginLeft}
            />
            <NumberCell
              label="Right"
              value={marginRight}
              onChange={setMarginRight}
            />
          </div>
        </fieldset>

        <div className="flex flex-col gap-1.5 lg:col-span-2">
          <Label
            htmlFor="rule-exhibits"
            className="text-xs font-medium text-[#40233f]"
          >
            Required exhibits — comma separated
          </Label>
          <Input
            id="rule-exhibits"
            value={exhibits}
            onChange={(e) => setExhibits(e.target.value)}
            className="font-numerals"
          />
        </div>

        <fieldset className="rounded-xl border border-border/60 bg-card/60 p-4 lg:col-span-2">
          <legend className="px-2 text-xs font-medium text-[#40233f]">
            Fee schedule · USD
          </legend>
          <div className="grid grid-cols-3 gap-3">
            <NumberCell
              label="First page"
              value={firstPage}
              onChange={setFirstPage}
            />
            <NumberCell
              label="Each addl"
              value={additionalPage}
              onChange={setAdditionalPage}
            />
            <NumberCell
              label="SDF"
              value={salesDisclosureFee}
              onChange={setSalesDisclosureFee}
            />
          </div>
        </fieldset>
      </div>

      {error && (
        <div className="mx-7 mb-4 rounded-md border border-[#b94f58]/30 bg-[#fdecee] px-3 py-2 text-sm text-[#8a3942]">
          {error}
        </div>
      )}

      <footer className="flex items-center justify-between border-t border-border/60 bg-[#f9f5ef]/50 px-7 py-4">
        <div className="text-xs text-muted-foreground">
          A new version is recorded with full audit trail. The previous version
          is closed at this date.
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={onDone}>
            Discard
          </Button>
          <Button type="submit" disabled={pending} className="gap-2">
            <Stamp className="size-4" />
            {pending ? 'Recording...' : 'Publish version'}
          </Button>
        </div>
      </footer>
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
  const id = `numcell-${label.replace(/\s+/g, '-')}`
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        step="0.5"
        min={0}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="font-numerals tabular-nums"
      />
    </div>
  )
}
