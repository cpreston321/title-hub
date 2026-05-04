import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useConvexMutation } from "@convex-dev/react-query";
import { ConvexError } from "convex/values";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CheckCircle2,
  Loader2,
  Mail,
  MapPin,
  ScrollText,
  Sparkles,
  User,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "../../convex/_generated/api";
import { BrandMark } from "./index";

type RequestState = {
  contactName: string;
  email: string;
  firmName: string;
  role: string;
  region: string;
  monthlyVolume: string;
  note: string;
  // Honeypot — humans never fill this. The field is visually hidden.
  company: string;
};

const ROLES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "owner", label: "Owner / principal" },
  { id: "examiner", label: "Title examiner" },
  { id: "closer", label: "Closing agent" },
  { id: "processor", label: "Processor" },
  { id: "operations", label: "Operations / admin" },
  { id: "underwriter", label: "Underwriter" },
  { id: "other", label: "Something else" },
];

const VOLUMES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "<10", label: "Under 10 files / month" },
  { id: "10-50", label: "10 – 50 files / month" },
  { id: "50-200", label: "50 – 200 files / month" },
  { id: "200-500", label: "200 – 500 files / month" },
  { id: "500+", label: "500+ files / month" },
];

export const Route = createFileRoute("/request-invite")({
  head: () => {
    const title = "Request an invitation · Title Hub";
    const description =
      "Title Hub is in pilot with a small set of agencies. Tell us about your firm and we'll be in touch.";
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: description },
        { name: "robots", content: "noindex, nofollow" },
      ],
    };
  },
  component: RequestInvitePage,
});

function RequestInvitePage() {
  const submit = useConvexMutation(api.accessRequests.submit);

  const [form, setForm] = useState<RequestState>({
    contactName: "",
    email: "",
    firmName: "",
    role: "",
    region: "",
    monthlyVolume: "",
    note: "",
    company: "",
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const set = <K extends keyof RequestState>(k: K, v: RequestState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      await submit({
        contactName: form.contactName.trim(),
        email: form.email.trim(),
        firmName: form.firmName.trim(),
        role: form.role || undefined,
        region: form.region.trim() || undefined,
        monthlyVolume: form.monthlyVolume || undefined,
        note: form.note.trim() || undefined,
        company: form.company || undefined,
      });
      setDone(true);
    } catch (err) {
      const msg =
        err instanceof ConvexError
          ? String(err.data ?? err.message ?? err)
          : err instanceof Error
            ? err.message
            : "Something went wrong. Try again.";
      setError(msg.replace(/^.*ConvexError:\s*/, ""));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="relative flex min-h-svh flex-col overflow-x-clip">
      <Backdrop />
      <TopBar />

      <main className="relative mx-auto grid w-full max-w-[1240px] flex-1 grid-cols-1 gap-12 px-6 pt-12 pb-20 lg:grid-cols-[5fr_6fr] lg:gap-16 lg:pt-16">
        <EditorialColumn />

        <section className="relative">
          {done ? (
            <ConfirmationPanel
              firmName={form.firmName}
              email={form.email}
              onAnother={() => {
                setDone(false);
                setForm((f) => ({ ...f, note: "", monthlyVolume: "", role: "" }));
              }}
            />
          ) : (
            <FormPanel
              form={form}
              set={set}
              pending={pending}
              error={error}
              onSubmit={onSubmit}
            />
          )}
        </section>
      </main>

      <Footer />
    </div>
  );
}

// ─── Decorative atmosphere ──────────────────────────────────────────────────

function Backdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      <div className="absolute inset-0 paper-grain opacity-40" />
      <div className="absolute -top-32 -left-32 size-[36rem] rounded-full bg-[radial-gradient(circle_at_30%_30%,rgba(244,212,143,0.34),transparent_60%)] blur-3xl" />
      <div className="absolute top-[34%] -right-40 size-[34rem] rounded-full bg-[radial-gradient(circle_at_70%_30%,rgba(115,64,112,0.22),transparent_60%)] blur-3xl" />
      <div className="absolute bottom-[-10rem] left-[20%] size-[28rem] rounded-full bg-[radial-gradient(circle_at_30%_60%,rgba(63,124,100,0.18),transparent_60%)] blur-3xl" />
    </div>
  );
}

// ─── Top bar ────────────────────────────────────────────────────────────────

function TopBar() {
  return (
    <header className="relative border-b border-border/40 bg-background/70 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1240px] items-center justify-between gap-4 px-6 py-4">
        <Link to="/" className="flex items-center gap-3">
          <BrandMark />
          <div className="leading-tight">
            <div className="font-display text-base font-semibold tracking-tight text-[#40233f]">
              Title Hub
            </div>
            <div className="text-[11px] tracking-[0.04em] text-muted-foreground">
              A file-of-record for the title trade
            </div>
          </div>
        </Link>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm" className="gap-1.5">
            <Link to="/">
              <ArrowLeft className="size-3.5" />
              Back to home
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/signin">Sign in</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}

// ─── Left column: editorial copy ───────────────────────────────────────────

function EditorialColumn() {
  return (
    <div className="relative">
      <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-card px-3 py-1 text-[11px] font-semibold tracking-[0.1em] text-[#b78625] shadow-sm uppercase">
        <Sparkles className="size-3.5" />
        Pilot · invite only
      </div>
      <h1 className="mt-6 font-display text-[2.75rem] leading-[1.02] font-semibold tracking-tight text-[#40233f] md:text-[3.5rem] lg:text-[4rem]">
        Request an{" "}
        <span className="italic font-[450] text-[#593157]">invitation.</span>
      </h1>
      <div className="mt-6 flex items-center gap-3 text-[#40233f]/70">
        <span className="font-display text-2xl italic">§</span>
        <span className="h-px w-10 bg-[#40233f]/25" />
        <span className="font-numerals text-[10px] font-semibold tracking-[0.32em] uppercase">
          A note from us
        </span>
      </div>
      <p className="tk-drop-cap mt-6 max-w-[34rem] text-[15px] leading-[1.7] text-foreground/80 md:text-[16px]">
        Title Hub is in pilot with a small set of agencies. We're adding firms
        a few at a time so we can sit beside the work and keep the rough edges
        to a minimum. Tell us about your shop below — what you handle, where
        you handle it, what hurts in your day. We'll write back personally.
      </p>

      <ul className="mt-8 flex flex-col gap-4">
        <PromiseRow
          icon={<CheckCircle2 className="size-3.5" />}
          title="Personal reply"
          body="A real person responds within two business days."
        />
        <PromiseRow
          icon={<CheckCircle2 className="size-3.5" />}
          title="Quiet pilot"
          body="No public sign-up form. We onboard each firm by hand."
        />
        <PromiseRow
          icon={<CheckCircle2 className="size-3.5" />}
          title="Your information stays put"
          body="Used only to evaluate fit for the pilot. Never sold, never shared."
        />
      </ul>

      <div className="mt-10 hidden rounded-2xl border border-border/60 bg-card/80 p-5 shadow-sm ring-1 ring-foreground/5 lg:block">
        <div className="font-numerals text-[10px] font-semibold tracking-[0.18em] text-[#b78625] uppercase">
          Currently in pilot with
        </div>
        <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px] text-[#40233f]/80">
          <li className="font-numerals tracking-[0.04em]">7 firms</li>
          <li className="font-numerals tracking-[0.04em]">3 states</li>
          <li className="font-numerals tracking-[0.04em]">312 files / week</li>
          <li className="font-numerals tracking-[0.04em]">SoftPro 360</li>
        </ul>
      </div>
    </div>
  );
}

function PromiseRow({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-[#e6f3ed] text-[#2f5d4b] ring-1 ring-inset ring-[#3f7c64]/30">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="font-display text-[15px] font-semibold tracking-tight text-[#40233f]">
          {title}
        </div>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {body}
        </p>
      </div>
    </li>
  );
}

// ─── Right column: form panel ───────────────────────────────────────────────

function FormPanel({
  form,
  set,
  pending,
  error,
  onSubmit,
}: {
  form: RequestState;
  set: <K extends keyof RequestState>(k: K, v: RequestState[K]) => void;
  pending: boolean;
  error: string | null;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const valid =
    form.contactName.trim().length >= 2 &&
    form.firmName.trim().length >= 2 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());

  return (
    <article className="relative overflow-hidden rounded-3xl border border-[#40233f]/15 bg-card shadow-2xl ring-1 ring-foreground/10">
      {/* Letterhead */}
      <header className="flex items-baseline justify-between gap-4 border-b border-border/50 bg-[#fdf6e8]/60 px-7 pt-6 pb-4">
        <div>
          <div className="font-numerals text-[10px] font-semibold tracking-[0.22em] text-[#b78625] uppercase">
            Application
          </div>
          <h2 className="mt-1 font-display text-2xl font-semibold tracking-tight text-[#40233f]">
            Tell us about your firm.
          </h2>
        </div>
        <div className="font-numerals hidden text-right text-[10px] tracking-[0.18em] text-muted-foreground uppercase sm:block">
          <div>Vol. I · No. 1</div>
          <div>Spring · MMXXVI</div>
        </div>
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-5 px-7 py-7">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <Field
            id="contactName"
            label="Your name"
            required
            icon={<User className="size-3.5" />}
          >
            <Input
              id="contactName"
              autoComplete="name"
              required
              minLength={2}
              maxLength={120}
              value={form.contactName}
              onChange={(e) => set("contactName", e.target.value)}
              placeholder="Jane Doe"
            />
          </Field>

          <Field
            id="email"
            label="Work email"
            required
            icon={<Mail className="size-3.5" />}
          >
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              maxLength={200}
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
              placeholder="jane@firm.com"
            />
          </Field>
        </div>

        <Field
          id="firmName"
          label="Firm or agency name"
          required
          icon={<Building2 className="size-3.5" />}
        >
          <Input
            id="firmName"
            autoComplete="organization"
            required
            minLength={2}
            maxLength={160}
            value={form.firmName}
            onChange={(e) => set("firmName", e.target.value)}
            placeholder="Quality Title Insurance LLC"
          />
        </Field>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <Field
            id="role"
            label="Your role"
            icon={<ScrollText className="size-3.5" />}
          >
            <Select
              value={form.role}
              onValueChange={(v) => set("role", v)}
            >
              <SelectTrigger id="role" className="w-full">
                <SelectValue placeholder="Pick one" />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field
            id="region"
            label="State or counties"
            icon={<MapPin className="size-3.5" />}
            hint="Where you record. Indiana, Marion + Hamilton, etc."
          >
            <Input
              id="region"
              autoComplete="address-level1"
              maxLength={120}
              value={form.region}
              onChange={(e) => set("region", e.target.value)}
              placeholder="Indiana — Marion, Hamilton"
            />
          </Field>
        </div>

        <Field
          id="monthlyVolume"
          label="Monthly file volume"
          hint="A rough range is fine. We don't share this."
        >
          <Select
            value={form.monthlyVolume}
            onValueChange={(v) => set("monthlyVolume", v)}
          >
            <SelectTrigger id="monthlyVolume" className="w-full">
              <SelectValue placeholder="Pick a range" />
            </SelectTrigger>
            <SelectContent>
              {VOLUMES.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          id="note"
          label="Anything else"
          hint="What's the most painful part of your closings right now? Any system you're trying to leave?"
        >
          <Textarea
            id="note"
            rows={4}
            maxLength={1000}
            value={form.note}
            onChange={(e) => set("note", e.target.value)}
            placeholder="The blank lines on a CD that nobody owns, the third-time-this-week buyer-name typo, the county that won't accept margins under 3 inches…"
            className="resize-y"
          />
        </Field>

        {/* Honeypot. Humans never see/fill this — autocomplete off, hidden
            from screen readers, off-screen positioning. Bots will submit. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -left-[9999px] h-0 w-0 overflow-hidden opacity-0"
        >
          <label htmlFor="company">
            Company (do not fill)
            <input
              id="company"
              name="company"
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={form.company}
              onChange={(e) => set("company", e.target.value)}
            />
          </label>
        </div>

        {error && (
          <div className="rounded-md border border-[#b94f58]/30 bg-[#fdecee] px-3 py-2 text-sm text-[#8a3942]">
            {error}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border/50 pt-5">
          <p className="max-w-md text-[11px] leading-relaxed text-muted-foreground">
            By submitting, you're asking to be considered for the pilot. We'll
            reply personally within two business days.
          </p>
          <Button
            type="submit"
            size="lg"
            disabled={!valid || pending}
            className="tk-letterpress gap-2 shadow-lg shadow-[#40233f]/15"
          >
            {pending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                Submit request
                <ArrowRight className="size-4" />
              </>
            )}
          </Button>
        </div>
      </form>
    </article>
  );
}

function Field({
  id,
  label,
  hint,
  required,
  icon,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  required?: boolean;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label
        htmlFor={id}
        className="flex items-center gap-1.5 text-[12px] font-medium tracking-[0.04em] text-[#40233f]"
      >
        {icon && <span className="text-[#b78625]">{icon}</span>}
        {label}
        {required && (
          <span aria-hidden className="ml-0.5 text-[#b94f58]">
            *
          </span>
        )}
      </Label>
      {children}
      {hint && (
        <span className="text-[11px] leading-snug text-muted-foreground">
          {hint}
        </span>
      )}
    </div>
  );
}

// ─── Confirmation panel ────────────────────────────────────────────────────

function ConfirmationPanel({
  firmName,
  email,
  onAnother,
}: {
  firmName: string;
  email: string;
  onAnother: () => void;
}) {
  return (
    <article className="relative overflow-hidden rounded-3xl border border-[#40233f]/15 bg-card shadow-2xl ring-1 ring-foreground/10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 paper-grain opacity-50"
      />
      <div className="relative flex flex-col items-center gap-6 px-7 py-12 text-center">
        <ConfirmationSeal />
        <div>
          <div className="font-numerals text-[10px] font-semibold tracking-[0.22em] text-[#b78625] uppercase">
            Filed · received · stamped
          </div>
          <h2 className="mt-2 font-display text-3xl font-semibold tracking-tight text-[#40233f]">
            Your request is in.
          </h2>
        </div>
        <p className="max-w-md text-[14px] leading-relaxed text-foreground/80">
          We've recorded your application
          {firmName ? (
            <>
              {" "}
              for{" "}
              <strong className="font-semibold text-[#40233f]">
                {firmName}
              </strong>
            </>
          ) : null}
          . A real person on our team will write back to{" "}
          <span className="font-numerals text-[#40233f]">{email}</span> within
          two business days.
        </p>
        <div className="my-2 deckle w-32" />
        <p className="max-w-md text-[12px] leading-relaxed text-muted-foreground">
          In the meantime, feel free to{" "}
          <Link
            to="/"
            className="font-medium text-[#40233f] underline underline-offset-2 hover:text-[#593157]"
          >
            return home
          </Link>{" "}
          to read more about the pilot.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <Button asChild size="lg" className="tk-letterpress gap-2">
            <Link to="/">
              Back to home
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={onAnother}
          >
            Submit another
          </Button>
        </div>
      </div>
    </article>
  );
}

function ConfirmationSeal() {
  return (
    <div
      className="relative grid place-items-center"
      style={{ width: 140, height: 140 }}
      aria-hidden
    >
      <svg
        viewBox="0 0 100 100"
        className="tk-seal-rotor absolute inset-0"
        aria-hidden
      >
        <defs>
          <path
            id="confirm-arc-top"
            d="M 5.5 50 A 44.5 44.5 0 0 1 94.5 50"
            fill="none"
          />
          <path
            id="confirm-arc-bottom"
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
          fontSize="3.2"
          fontWeight="600"
          fill="#40233f"
          opacity="0.8"
          letterSpacing="0.55"
          textAnchor="middle"
        >
          <textPath href="#confirm-arc-top" startOffset="50%">
            FILED · RECEIVED · STAMPED
          </textPath>
        </text>
        <text
          fontFamily="Fraunces, serif"
          fontSize="3.2"
          fontWeight="600"
          fill="#40233f"
          opacity="0.8"
          letterSpacing="0.55"
          textAnchor="middle"
        >
          <textPath href="#confirm-arc-bottom" startOffset="50%">
            · TITLE · HUB · MMXXVI ·
          </textPath>
        </text>
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
              strokeOpacity={major ? 0.6 : 0.3}
              strokeLinecap="round"
              transform={`rotate(${i * 6} 50 50)`}
            />
          );
        })}
      </svg>
      <div
        className="tk-seal-disc tk-stamp-press absolute rounded-full"
        style={{
          inset: "22%",
          background:
            "radial-gradient(circle at 30% 26%, #f7e0a8 0%, #d6a447 38%, #b78625 64%, #8c6210 100%)",
          boxShadow:
            "inset 0 0 0 1px rgba(64,35,63,0.34), inset 0 1px 0 rgba(255,250,235,0.55), 0 1px 1px rgba(64,35,63,0.18), 0 8px 22px -8px rgba(64,35,63,0.45)",
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
          className="font-display absolute inset-0 grid place-items-center text-[28px] leading-none font-semibold text-[#40233f]"
          style={{ textShadow: "0 1px 0 rgba(255,253,247,0.6)" }}
        >
          ❦
        </span>
      </div>
    </div>
  );
}

// ─── Footer ────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="relative border-t border-border/60 bg-[#fdf6e8]/40">
      <div className="mx-auto flex w-full max-w-[1240px] flex-wrap items-center justify-between gap-3 px-6 py-6 text-[11px] text-muted-foreground">
        <span>
          © {new Date().getFullYear()} Title Hub. Pilot environment.
        </span>
        <div className="flex items-center gap-5">
          <Link to="/" className="transition hover:text-[#40233f]">
            Home
          </Link>
          <Link to="/signin" className="transition hover:text-[#40233f]">
            Sign in
          </Link>
        </div>
      </div>
    </footer>
  );
}
