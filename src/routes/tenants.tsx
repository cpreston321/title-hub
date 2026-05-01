import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AppShell } from '@/components/app-shell'
import { authClient } from '@/lib/auth-client'
import { toKebabCase } from '@/lib/utils'
import { api } from '../../convex/_generated/api'

export const Route = createFileRoute('/tenants')({
  head: () => ({
    meta: [
      { title: 'Workspaces · Title Hub' },
      {
        name: 'description',
        content: 'Pick a workspace or create a new agency tenant in Title Hub.',
      },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!(context as { isAuthenticated?: boolean }).isAuthenticated) {
      throw redirect({ to: '/signin' })
    }
  },
  component: TenantsPage,
})

function TenantsPage() {
  const router = useRouter()
  const memberships = useQuery(convexQuery(api.tenants.listMine, {}))
  const isAdminQ = useQuery(convexQuery(api.tenants.amISystemAdmin, {}))
  const isSystemAdmin = isAdminQ.data === true

  const [slug, setSlug] = useState('')
  const [legalName, setLegalName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const onPick = async (betterAuthOrgId: string) => {
    const res = await authClient.organization.setActive({
      organizationId: betterAuthOrgId,
    })
    if (res.error) {
      setError(res.error.message ?? 'Failed to switch organization')
      return
    }
    router.navigate({ to: '/files' })
  }

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      const res = await authClient.organization.create({
        name: legalName,
        slug: slug.replace(/-+$/, ''),
      })
      if (res.error) throw new Error(res.error.message ?? 'Failed to create')
      // Better Auth sets the new org as active automatically.
      router.navigate({ to: '/files' })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  const list = memberships.data?.memberships ?? []

  return (
    <AppShell
      isAuthenticated
      title="Organizations"
      subtitle="Pick an existing organization or create a new one."
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        {list.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Your organizations</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {list.map((m) => (
                <div
                  key={m.tenantId}
                  className="flex items-center justify-between rounded-md border border-border/60 p-3"
                >
                  <div>
                    <div className="font-medium">{m.legalName}</div>
                    <div className="text-xs text-muted-foreground">
                      {m.slug} · {m.role}
                    </div>
                  </div>
                  <Button onClick={() => onPick(m.betterAuthOrgId)}>
                    Open
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {isSystemAdmin ? (
          <Card>
            <CardHeader>
              <CardTitle>Create a new organization</CardTitle>
              <CardDescription>
                You'll become the owner. NPI access is enabled by default.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={onCreate} className="flex flex-col gap-3">
                <Input
                  placeholder="Slug (e.g. quality-title)"
                  value={slug}
                  onChange={(e) => setSlug(toKebabCase(e.target.value))}
                  required
                  minLength={2}
                  maxLength={40}
                />
                <Input
                  placeholder="Legal name (e.g. Quality Title Insurance LLC)"
                  value={legalName}
                  onChange={(e) => setLegalName(e.target.value)}
                  required
                  minLength={2}
                />
                {error && <p className="text-sm text-destructive">{error}</p>}
                <Button type="submit" disabled={pending}>
                  {pending ? 'Creating...' : 'Create'}
                </Button>
              </form>
            </CardContent>
          </Card>
        ) : (
          list.length === 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Awaiting an invitation</CardTitle>
                <CardDescription>
                  Your account is set up, but you haven't been invited to an
                  organization yet. Ask your administrator to send you an
                  invitation — you'll be able to sign in here once they do.
                </CardDescription>
              </CardHeader>
            </Card>
          )
        )}
      </div>
    </AppShell>
  )
}
