/**
 * One Import (the dashboard's per-import hydration; also the plain-HTTP
 * surface the tests use to observe worker-written state, e.g. failure
 * reasons).
 */
import { eq } from "drizzle-orm"

import { imports } from "@workspace/db/schema"

import { getDb } from "@/lib/db"
import { toImportDto } from "@/lib/imports"

export const runtime = "nodejs"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params
  const db = getDb().db
  const rows = await db
    .select()
    .from(imports)
    .where(eq(imports.id, id))
    .limit(1)
  if (rows.length === 0) {
    return Response.json(
      { error: { code: "not_found", message: "Import not found." } },
      { status: 404 }
    )
  }
  return Response.json({ import: toImportDto(rows[0]!) })
}
