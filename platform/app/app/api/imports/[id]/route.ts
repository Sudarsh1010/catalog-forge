/**
 * One Import, in full detail: the dashboard's per-Import hydration and the
 * plain-HTTP surface the tests use to observe worker-written state. The
 * snapshot carries per-stage Job counts, the Row Ledger reconciliation
 * against the sheet total, per-row errors with their retryable Jobs, Parked
 * Photos and the Products (ADR-0004: dashboard state is read-only).
 */
import { getDb } from "@/lib/db"
import { loadImportDetail } from "@/lib/imports"

export const runtime = "nodejs"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params
  const detail = await loadImportDetail(getDb().db, id)
  if (!detail) {
    return Response.json(
      { error: { code: "not_found", message: "Import not found." } },
      { status: 404 }
    )
  }
  return Response.json({ import: detail })
}
