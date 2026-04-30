import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { authClient } from "@/lib/auth-client"

type SignInSearch = { mode?: "sign-in" | "sign-up" }

export const Route = createFileRoute("/signin")({
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
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [magicSent, setMagicSent] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      if (mode === "sign-up") {
        const res = await authClient.signUp.email({ email, password, name })
        if (res.error) throw new Error(res.error.message ?? "Sign-up failed")
      } else {
        const res = await authClient.signIn.email({ email, password })
        if (res.error) throw new Error(res.error.message ?? "Sign-in failed")
      }
      navigate({ to: "/files" })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  const sendMagicLink = async () => {
    if (!email) {
      setError("Enter your email first.")
      return
    }
    setPending(true)
    setError(null)
    try {
      const res = await authClient.signIn.magicLink({
        email,
        callbackURL: "/files",
      })
      if (res.error) throw new Error(res.error.message ?? "Magic link failed")
      setMagicSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  const oauth = async (provider: "google" | "microsoft") => {
    setPending(true)
    setError(null)
    try {
      const res = await authClient.signIn.social({
        provider,
        callbackURL: "/files",
      })
      if (res.error) throw new Error(res.error.message ?? `${provider} sign-in failed`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-sm flex-col gap-3 rounded-lg border p-6"
      >
        <h1 className="text-lg font-medium">
          {mode === "sign-up" ? "Create account" : "Sign in"}
        </h1>

        {mode === "sign-up" && (
          <input
            className="rounded border px-3 py-2 text-sm"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        )}
        <input
          className="rounded border px-3 py-2 text-sm"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="rounded border px-3 py-2 text-sm"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />

        {error && <p className="text-sm text-red-600">{error}</p>}
        {magicSent && (
          <p className="text-sm text-green-700">
            Magic link sent. Check {email}.
          </p>
        )}

        <Button type="submit" disabled={pending}>
          {pending
            ? "..."
            : mode === "sign-up"
              ? "Create account"
              : "Sign in"}
        </Button>

        <div className="my-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" /> or{" "}
          <span className="h-px flex-1 bg-border" />
        </div>

        <Button
          type="button"
          variant="outline"
          onClick={sendMagicLink}
          disabled={pending}
        >
          Email me a sign-in link
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => oauth("google")}
          disabled={pending}
        >
          Continue with Google
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => oauth("microsoft")}
          disabled={pending}
        >
          Continue with Microsoft
        </Button>

        <button
          type="button"
          className="text-xs text-muted-foreground underline"
          onClick={() =>
            setMode(mode === "sign-in" ? "sign-up" : "sign-in")
          }
        >
          {mode === "sign-in"
            ? "Need an account? Sign up"
            : "Already have an account? Sign in"}
        </button>

        <Link to="/" className="text-xs text-muted-foreground">
          Back home
        </Link>
      </form>
    </div>
  )
}
