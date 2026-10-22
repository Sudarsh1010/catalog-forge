"use client"

/**
 * Client providers: TanStack Query cache for ADR-0004 read-only dashboard
 * state, plus the theme provider (dark-mode hotkey included). The
 * QueryClient lives in lazy useState so fast navigations keep the cache
 * (no suspense data loss) while staying per-request on the server.
 */
import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { ThemeProvider } from "@/components/theme-provider"

export function Providers({
  children,
}: {
  children: React.ReactNode
}): React.ReactElement {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      })
  )

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ThemeProvider>
  )
}
