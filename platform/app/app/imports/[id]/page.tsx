/**
 * The per-Import page (issue #9): stage timeline with live Job counts, the
 * Row Ledger reconciliation, per-row errors with retry, Parked Photos and
 * the re-run enrichment surface. The server hydrates the detail snapshot;
 * the client keeps it live over SSE.
 */
import { notFound } from "next/navigation"

import { getDb } from "@/lib/db"
import { loadImportDetail } from "@/lib/imports"

import { ImportDetail } from "@/components/import-detail"

export default async function ImportPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const detail = await loadImportDetail(getDb().db, id)
  if (!detail) notFound()
  return <ImportDetail initial={detail} />
}
