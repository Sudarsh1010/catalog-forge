/**
 * The dashboard (ticket #19): server-driven like the Products tab — the
 * import queue and the Metrics tab hydrate from the Postgres views in
 * this RSC page, so the content renders in the SSR HTML and reflects
 * live pipeline state on every request. The client keeps it live over
 * the import SSE stream.
 */
import { desc } from "drizzle-orm"

import { imports } from "@workspace/db/schema"

import { DashboardTabs } from "@/components/dashboard-tabs"
import { getDb } from "@/lib/db"
import { toImportDto } from "@/lib/imports"
import { loadMetricsOverview } from "@/lib/metrics"

export const dynamic = "force-dynamic"

export default async function Page() {
  const db = getDb().db
  // Same surface the oRPC import.list procedure serves (newest first,
  // 100-Import cap) — one source of truth for the queue.
  const [rows, metrics] = await Promise.all([
    db.select().from(imports).orderBy(desc(imports.createdAt)).limit(100),
    loadMetricsOverview(db),
  ])

  return (
    <DashboardTabs
      initialImports={rows.map(toImportDto)}
      initialMetrics={metrics}
    />
  )
}
