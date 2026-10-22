"use client"

/**
 * The dashboard shell (ticket #19): the Import queue and the Metrics tab
 * over the Postgres views. Tab state is genuinely-local UI state — no
 * server state beyond the queries each panel already owns.
 */
import { useState } from "react"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs"

import { ImportDashboard } from "./import-dashboard"
import { MetricsPanel } from "./metrics-panel"

type DashboardTab = "imports" | "metrics"

export function DashboardTabs(): React.ReactElement {
  const [tab, setTab] = useState<DashboardTab>("imports")

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as DashboardTab)}>
      <TabsList>
        <TabsTrigger value="imports">Imports</TabsTrigger>
        <TabsTrigger value="metrics">Metrics</TabsTrigger>
      </TabsList>
      <TabsContent value="imports">
        <ImportDashboard />
      </TabsContent>
      <TabsContent value="metrics">
        <MetricsPanel />
      </TabsContent>
    </Tabs>
  )
}
