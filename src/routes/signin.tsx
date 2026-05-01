import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Loader2,
  Mail,
  ShieldCheck,
  Sparkles,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authClient } from "@/lib/auth-client"
import { BrandMark } from "./index"

type AuthErrorShape = { message?: string | null; status?: number | null; code?: string | null }
type FriendlyError = {
  title: string
  body: string
  suggestion?: "magic" | "signup" | "signin"
}

function friendlyAuthError(
  raw: unknown,
  context: "sign-in" | "sign-up" | "magic" | "oauth",
): FriendlyError {
  const e = (raw && typeof raw === "object" ? raw : {}) as AuthErrorShape
  const msg = (e.message ?? "").toString()
  const lower = msg.toLowerCase()
  const status = e.status ?? 0
  const code = (e.code ?? "").toString().toLowerCase()

  // Account already exists when signing up.
  if (
    context === "sign-up" &&
    (lower.includes("already") ||
      lower.includes("exists") ||
      code.includes("user_already_exists") ||
      status === 409 ||
      status === 422)
  ) {
    return {
      title: "An account with that email already exists.",
      body: "Try signing in instead, or use a sign-in link if you've forgotten your password.",
      suggestion: "signin",
    }
  }

  // Invalid credentials — Better Auth typically returns 401, but the Convex
  // adapter sometimes wraps it in a 500 "HTTPError". Treat both as bad
  // credentials for the sign-in flow because that's the overwhelming cause.
  if (
    context === "sign-in" &&
    (status === 401 ||
      status === 500 ||
      lower.includes("invalid") ||
      lower.includes("password") ||
      lower === "httperror")
  ) {
    return {
      title: "That email and password didn't match an account.",
      body: "Double-check the spelling, send yourself a one-time sign-in link, or create a new account if you haven't yet.",
      suggestion: "magic",
    }
  }

  if (lower.includes("rate") || status === 429) {
    return {
      title: "Too many attempts.",
      body: "Wait a minute and try again, or request a sign-in link.",
      suggestion: "magic",
    }
  }

  if (lower.includes("network") || lower.includes("failed to fetch")) {
    return {
      title: "We couldn't reach the server.",
      body: "Check your connection and try again.",
    }
  }

  if (
    context === "magic" &&
    (lower.includes("not found") || lower.includes("no user") || status === 404)
  ) {
    return {
      title: "No account uses that email.",
      body: "Sign up first, then we can send you a magic link.",
      suggestion: "signup",
    }
  }

  // Fallback. Show whatever the server said but keep it composed.
  return {
    title:
      context === "sign-up"
        ? "We couldn't create your account."
        : context === "magic"
          ? "We couldn't send your sign-in link."
          : context === "oauth"
            ? "We couldn't sign you in with that provider."
            : "We couldn't sign you in.",
    body:
      msg && lower !== "httperror"
        ? msg
        : "Something went wrong on our side. Try again, or use one of the alternates below.",
  }
}

type SignInSearch = { mode?: "sign-in" | "sign-up" }

export const Route = createFileRoute("/signin")({
  head: () => {
    const title = "Sign in · Title Hub"
    const description =
      "Sign in to Title Hub to manage files, documents, and cross-document reconciliation."
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: description },
      ],
    }
  },
  component: SignInPage,
  validateSearch: (raw): SignInSearch => {
    const m = (raw as Record<string, unknown>).mode
    return m === "sign-up" || m === "sign-in" ? { mode: m } : {}
  },
})

function SignInPage() {
  const navigate = useNavigate()
  const search = Route.useSearch() as SignInSearch
  const [mode, setMode] = useState<"sign-in" | "sign-up">(
    search.mode === "sign-up" ? "sign-up" : "sign-in",
  )
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [name, setName] = useState("")
  const [error, setError] = useState<FriendlyError | null>(null)
  const [pending, setPending] = useState<
    null | "primary" | "magic" | "google" | "microsoft"
  >(null)
  const [magicSent, setMagicSent] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setPending("primary")
    setError(null)
    const ctx: "sign-in" | "sign-up" = mode === "sign-up" ? "sign-up" : "sign-in"
    try {
      const res =
        mode === "sign-up"
          ? await authClient.signUp.email({ email, password, name })
          : await authClient.signIn.email({ email, password })
      if (res.error) {
        setError(friendlyAuthError(res.error, ctx))
        return
      }
      navigate({ to: "/" })
    } catch (err) {
      setError(friendlyAuthError(err, ctx))
    } finally {
      setPending(null)
    }
  }

  const sendMagicLink = async () => {
    if (!email.trim()) {
      setError({
        title: "Enter your email first.",
        body: "We'll send a one-time link to that address.",
      })
      return
    }
    setPending("magic")
    setError(null)
    try {
      const res = await authClient.signIn.magicLink({
        email,
        callbackURL: "/",
      })
      if (res.error) {
        setError(friendlyAuthError(res.error, "magic"))
        return
      }
      setMagicSent(true)
    } catch (err) {
      setError(friendlyAuthError(err, "magic"))
    } finally {
      setPending(null)
    }
  }

  const oauth = async (provider: "google" | "microsoft") => {
    setPending(provider)
    setError(null)
    try {
      const res = await authClient.signIn.social({
        provider,
        callbackURL: "/",
      })
      if (res.error) {
        setError(friendlyAuthError(res.error, "oauth"))
      }
    } catch (err) {
      setError(friendlyAuthError(err, "oauth"))
    } finally {
      setPending(null)
    }
  }

  const isSignUp = mode === "sign-up"
  const primaryDisabled =
    pending !== null ||
    !email.trim() ||
    password.length < 8 ||
    (isSignUp && !name.trim())
  const busy = pending !== null

  return (
    <div className="min-h-svh">
      <div className="grid min-h-svh grid-cols-1 lg:grid-cols-[1.05fr_1fr]">
        <BrandPanel />

        <div className="relative flex flex-col">
          <div className="border-b border-border/60 px-6 py-4">
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-[#40233f]"
            >
              <ArrowLeft className="size-3.5" />
              Back to home
            </Link>
          </div>

          <div className="flex flex-1 items-center justify-center px-6 py-10">
            <div className="w-full max-w-md">
              <div className="lg:hidden">
                <BrandMark size="md" />
              </div>

              <div className="mt-2 lg:mt-0">
                <div className="text-xs font-semibold text-[#b78625]">
                  {isSignUp ? "New here" : "Welcome back"}
                </div>
                <h1 className="font-display mt-1 text-4xl font-semibold leading-tight tracking-tight text-[#40233f]">
                  {isSignUp ? "Create your account" : "Sign in to Title Hub"}
                </h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  {isSignUp
                    ? "Set up your login. We'll add you to your tenant once your invitation is approved."
                    : "Use your email and password, a one-time link, or your work account."}
                </p>
              </div>

              <ModeTabs mode={mode} setMode={setMode} disabled={busy} />

              <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-3">
                {isSignUp && (
                  <Field label="Full name" htmlFor="signin-name" required>
                    <Input
                      id="signin-name"
                      placeholder="Jane Doe"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      autoComplete="name"
                      required
                    />
                  </Field>
                )}
                <Field label="Email" htmlFor="signin-email" required>
                  <Input
                    id="signin-email"
                    type="email"
                    placeholder="you@firm.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    required
                  />
                </Field>
                <Field
                  label="Password"
                  htmlFor="signin-password"
                  required
                  hint={isSignUp ? "At least 8 characters." : undefined}
                >
                  <Input
                    id="signin-password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    autoComplete={
                      isSignUp ? "new-password" : "current-password"
                    }
                  />
                </Field>

                {error && (
                  <ErrorCallout
                    error={error}
                    busy={busy}
                    onSendMagicLink={sendMagicLink}
                    onSwitchMode={(target) => {
                      setError(null)
                      setMode(target)
                    }}
                  />
                )}
                {magicSent && (
                  <p className="flex items-start gap-2 rounded-md border border-[#3f7c64]/30 bg-[#e6f3ed] px-3 py-2 text-sm text-[#2f5d4b]">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                    <span>
                      Magic link sent. Check{" "}
                      <span className="font-medium">{email}</span> — the link
                      lasts 10 minutes.
                    </span>
                  </p>
                )}

                <Button
                  type="submit"
                  size="lg"
                  disabled={primaryDisabled}
                  className="mt-1 gap-2"
                >
                  {pending === "primary" ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {isSignUp ? "Creating..." : "Signing in..."}
                    </>
                  ) : (
                    <>
                      {isSignUp ? "Create account" : "Sign in"}
                      <ChevronRight className="size-4" />
                    </>
                  )}
                </Button>
              </form>

              <Divider label="or" />

              <div className="flex flex-col gap-2">
                <AltButton
                  onClick={sendMagicLink}
                  disabled={busy || !email.trim()}
                  loading={pending === "magic"}
                  icon={<Mail className="size-4" />}
                  label="Email me a sign-in link"
                />
                <AltButton
                  onClick={() => oauth("google")}
                  disabled={busy}
                  loading={pending === "google"}
                  icon={<GoogleMark />}
                  label="Continue with Google"
                />
                <AltButton
                  onClick={() => oauth("microsoft")}
                  disabled={busy}
                  loading={pending === "microsoft"}
                  icon={<MicrosoftMark />}
                  label="Continue with Microsoft"
                />
              </div>

              <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
                <button
                  type="button"
                  onClick={() => setMode(isSignUp ? "sign-in" : "sign-up")}
                  disabled={busy}
                  className="font-medium text-[#40233f] underline underline-offset-2 transition hover:text-[#593157] disabled:opacity-50"
                >
                  {isSignUp
                    ? "Already have an account? Sign in"
                    : "Need an account? Sign up"}
                </button>
                <span className="inline-flex items-center gap-1.5 text-xs">
                  <ShieldCheck className="size-3.5 text-[#3f7c64]" />
                  Secured by tenant-scoped sessions
                </span>
              </div>
            </div>
          </div>

          <div className="border-t border-border/60 bg-card/40 px-6 py-4 text-xs text-muted-foreground">
            By continuing you agree to operate within your tenant's policies
            and the audit trail attached to every action.
          </div>
        </div>
      </div>
    </div>
  )
}

function BrandPanel() {
  return (
    <aside className="relative hidden overflow-hidden bg-[#40233f] text-[#f6e8d9] lg:flex lg:flex-col">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          backgroundImage:
            "radial-gradient(circle at 30% 20%, rgba(244, 212, 143, 0.18), transparent 45%), radial-gradient(circle at 80% 80%, rgba(115, 64, 112, 0.45), transparent 55%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-20"
        style={{
          backgroundImage:
            "repeating-linear-gradient(to bottom, transparent 0, transparent 31px, rgba(246, 232, 217, 0.06) 31px, rgba(246, 232, 217, 0.06) 32px)",
        }}
      />

      <div className="relative flex h-full flex-col px-12 py-10">
        <Link to="/" className="flex items-center gap-3">
          <BrandMark size="md" />
          <div className="leading-tight">
            <div className="font-display text-base font-semibold tracking-tight text-white">
              Title Hub
            </div>
            <div className="text-xs text-white/55">
              Operations for title agencies
            </div>
          </div>
        </Link>

        <div className="mt-auto">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-[#f4d48f] ring-1 ring-inset ring-[#f4d48f]/30">
            <Sparkles className="size-3.5" />
            Pilot · invite only
          </div>
          <h2 className="font-display mt-5 max-w-md text-4xl font-semibold leading-[1.05] tracking-tight text-white md:text-5xl">
            Title operations,
            <br />
            made plain.
          </h2>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-white/70 md:text-base">
            One register for every file. Cross-document checks before closing.
            Versioned recording rules per county. Multi-tenant by construction.
          </p>

          <ul className="mt-8 grid gap-3 text-sm text-white/85">
            {[
              "Audit trail per file",
              "NPI tokenized and gated by role",
              "Reconciliation surfaces blockers before drafting",
              "Recording rules versioned per county",
            ].map((line) => (
              <li key={line} className="flex items-start gap-2.5">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[#f4d48f]" />
                {line}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative mt-10 text-xs text-white/50">
          © {new Date().getFullYear()} Title Hub
        </div>
      </div>
    </aside>
  )
}

function ModeTabs({
  mode,
  setMode,
  disabled,
}: {
  mode: "sign-in" | "sign-up"
  setMode: (m: "sign-in" | "sign-up") => void
  disabled?: boolean
}) {
  return (
    <div
      role="tablist"
      className="mt-6 inline-flex items-center gap-1 rounded-full bg-card p-1 ring-1 ring-border/70"
    >
      {(["sign-in", "sign-up"] as const).map((m) => {
        const selected = mode === m
        return (
          <button
            key={m}
            role="tab"
            type="button"
            aria-selected={selected}
            disabled={disabled}
            onClick={() => setMode(m)}
            className={`rounded-full px-4 py-1.5 text-sm transition ${
              selected
                ? "bg-[#40233f] text-[#f6e8d9] shadow-sm"
                : "text-muted-foreground hover:text-[#40233f]"
            } disabled:opacity-50`}
          >
            {m === "sign-in" ? "Sign in" : "Sign up"}
          </button>
        )
      })}
    </div>
  )
}

function Field({
  label,
  htmlFor,
  hint,
  required,
  children,
}: {
  label: string
  htmlFor: string
  hint?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-sm font-medium text-[#40233f]">
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
  )
}

function Divider({ label }: { label: string }) {
  return (
    <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="font-medium">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

function ErrorCallout({
  error,
  busy,
  onSendMagicLink,
  onSwitchMode,
}: {
  error: FriendlyError
  busy: boolean
  onSendMagicLink: () => void
  onSwitchMode: (target: "sign-in" | "sign-up") => void
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-xl border border-[#b94f58]/30 bg-[#fdecee] px-4 py-3 text-sm text-[#8a3942]"
    >
      <div className="flex items-start gap-2">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-snug">{error.title}</div>
          <div className="mt-0.5 text-[#8a3942]/85">{error.body}</div>
        </div>
      </div>
      {error.suggestion && (
        <div className="flex flex-wrap gap-2 pl-6">
          {error.suggestion === "magic" && (
            <button
              type="button"
              onClick={onSendMagicLink}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#40233f] px-3 py-1 text-xs font-medium text-[#f6e8d9] transition hover:bg-[#593157] disabled:opacity-50"
            >
              <Mail className="size-3.5" />
              Send me a sign-in link
            </button>
          )}
          {error.suggestion === "signup" && (
            <button
              type="button"
              onClick={() => onSwitchMode("sign-up")}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#40233f] px-3 py-1 text-xs font-medium text-[#f6e8d9] transition hover:bg-[#593157]"
            >
              Create an account
            </button>
          )}
          {error.suggestion === "signin" && (
            <button
              type="button"
              onClick={() => onSwitchMode("sign-in")}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#40233f] px-3 py-1 text-xs font-medium text-[#f6e8d9] transition hover:bg-[#593157]"
            >
              Switch to sign in
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function AltButton({
  onClick,
  disabled,
  loading,
  icon,
  label,
}: {
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  icon: React.ReactNode
  label: string
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="lg"
      onClick={onClick}
      disabled={disabled}
      className="justify-start gap-3"
    >
      <span className="flex size-5 items-center justify-center">
        {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      </span>
      <span className="flex-1 text-left">{label}</span>
    </Button>
  )
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.55-.2-2.27H12v4.51h6.46c-.28 1.46-1.13 2.7-2.4 3.53v2.93h3.87c2.27-2.09 3.56-5.17 3.56-8.7z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.95-2.91l-3.87-2.93c-1.08.72-2.45 1.16-4.08 1.16-3.13 0-5.78-2.11-6.73-4.96H1.27v3.11C3.25 21.31 7.31 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.36A7.21 7.21 0 0 1 4.88 12c0-.82.14-1.62.39-2.36V6.53H1.27A11.96 11.96 0 0 0 0 12c0 1.95.47 3.78 1.27 5.47l4-3.11z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.43-3.43C17.95 1.19 15.24 0 12 0 7.31 0 3.25 2.69 1.27 6.53l4 3.11C6.22 6.86 8.87 4.75 12 4.75z"
      />
    </svg>
  )
}

function MicrosoftMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="13" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="13" width="10" height="10" fill="#00A4EF" />
      <rect x="13" y="13" width="10" height="10" fill="#FFB900" />
    </svg>
  )
}
