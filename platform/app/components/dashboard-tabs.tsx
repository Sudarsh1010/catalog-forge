"use client"

/**
 * The dashboard shell (ticket #19): the Import queue and the Metrics tab
 * over the Postgres views. Both panels hydrate from the server-rendered
 * snapshot and stay live through their own queries and the SSE stream;
 * tab state is genuinely-local UI state.
 */
import { useState } from "react"
import type { ImportDto, MetricsOverviewDto } from "@workspace/contracts"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs"

import { ImportDashboard } from "./import-dashboard"
import { MetricsPanel } from "./metrics-panel"

type DashboardTab = "imports" | "metrics"

export function DashboardTabs({
  initialImports,
  initialMetrics,
}: {
  initialImports: ImportDto[]
  initialMetrics: MetricsOverviewDto
}): React.ReactElement {
  const [tab, setTab] = useState<DashboardTab>("imports")

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as DashboardTab)}>
      <TabsList>
        <TabsTrigger value="imports">Imports</TabsTrigger>
        <TabsTrigger value="metrics">Metrics</TabsTrigger>
      </TabsList>
      <TabsContent value="imports">
        <ImportDashboard initialImports={initialImports} />
      </TabsContent>
      <TabsContent value="metrics">
        <MetricsPanel initialOverview={initialMetrics} />
      </TabsContent>
    </Tabs>
  )
}
