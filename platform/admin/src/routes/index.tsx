import { createFileRoute } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

export const Route = createFileRoute("/")({
  component: () => (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <Button variant="outline">Get started</Button>
    </main>
  ),
})
