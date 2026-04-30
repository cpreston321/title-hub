import { createFileRoute, Link, useRouter } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { convexQuery } from "@convex-dev/react-query"
import { Button } from "@/components/ui/button"
import { authClient } from "@/lib/auth-client"
import { api } from "../../convex/_generated/api"

export const Route = createFileRoute("/")({ component: App })

function App() {
  const router = useRouter()
  const { isAuthenticated } = router.options.context as { isAuthenticated?: boolean }

  const currentUser = useQuery({
    ...convexQuery(api.auth.getCurrentUser, {}),
    enabled: !!isAuthenticated,
  })

  const handleSignOut = async () => {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          location.reload()
        },
      },
    })
  }

  return (
    <div className="flex min-h-svh p-6">
      <div className="flex max-w-md min-w-0 flex-col gap-4 text-sm leading-loose">
        <div>
          <h1 className="font-medium">Project ready!</h1>
          <p>You may now add components and start building.</p>
        </div>

        {isAuthenticated ? (
          <div className="flex flex-col gap-2">
            <p>
              Signed in as{" "}
              <span className="font-medium">
                {currentUser.data?.email ?? "..."}
              </span>
            </p>
            <Button onClick={handleSignOut}>Sign out</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p>You are signed out.</p>
            <Button asChild>
              <Link to="/signin">Sign in</Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
