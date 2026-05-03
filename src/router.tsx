import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { ConvexQueryClient } from '@convex-dev/react-query'
import { ConvexProvider } from 'convex/react'
import { routeTree } from './routeTree.gen'
import { ErrorPage } from './components/error-page'

export function getRouter() {
  const convexUrl = import.meta.env.VITE_CONVEX_URL
  if (!convexUrl) {
    throw new Error('VITE_CONVEX_URL is not set')
  }

  const convexQueryClient = new ConvexQueryClient(convexUrl, {
    expectAuth: true,
  })

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        queryKeyHashFn: convexQueryClient.hashFn(),
        queryFn: convexQueryClient.queryFn(),
        // Convex pushes invalidations over the websocket, so cached data is
        // always fresh while a subscription is mounted. Tell react-query the
        // same: avoid the "remount = refetch" flash when navigating between
        // pages that already have hot data.
        staleTime: Infinity,
        gcTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
      },
    },
  })

  convexQueryClient.connect(queryClient)

  const router = createTanStackRouter({
    routeTree,
    context: { queryClient, convexQueryClient },
    scrollRestoration: true,
    defaultPreload: 'intent',
    // Cache preloaded data for 30s so a hover-prefetched route can be opened
    // instantly. With 0, every nav re-fires the loader.
    defaultPreloadStaleTime: 30_000,
    // Show pending UI immediately on nav rather than waiting for a delay,
    // so route loaders that haven't resolved yet hand off to the page's
    // own skeletons without a stutter.
    defaultPendingMs: 0,
    defaultNotFoundComponent: () => <ErrorPage variant="not-found" />,
    defaultErrorComponent: ({ error, reset }) => (
      <ErrorPage variant="error" error={error} reset={reset} />
    ),
    Wrap: ({ children }) => (
      <ConvexProvider client={convexQueryClient.convexClient}>
        {children}
      </ConvexProvider>
    ),
  })

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
