/**
 * Dashboard retry (Ticket 6 poison path): the app writes the retry FACT —
 * one `job_retries` row per terminally-failed Job — and the Worker's
 * Sweeper adopts it by requeuing the Job with reset attempts (ADR-0004: the
 * app never touches Job machinery). Ticket 7 puts the button on this route.
 *
 * POST /api/imports/:id/retries   body: { jobIds?: string[] } (default: all
 * terminally-failed Jobs of the Import). Idempotent: a Job with a pending
 * request is skipped (unique index), so double-clicks are harmless.
 */
import { eq, sql } from "drizzle-orm"

import { imports } from "@workspace/db/schema"
import { DEFAULT_STORE_ID } from "@workspace/pipeline"

import { getDb } from "@/lib/db"
import { UUID_RE } from "@/lib/imports"

export const runtime = "nodejs"

const UUID_JOB_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params
  const db = getDb().db

  if (!UUID_RE.test(id)) {
    return Response.json(
      { error: { code: "not_found", message: "Import not found." } },
      { status: 404 }
    )
  }

  const existing = await db
    .select({ id: imports.id })
    .from(imports)
    .where(eq(imports.id, id))
    .limit(1)
  if (existing.length === 0) {
    return Response.json(
      { error: { code: "not_found", message: "Import not found." } },
      { status: 404 }
    )
  }

  // Optional body: retry specific Jobs; absent/empty = every failed one.
  let jobIds: string[] = []
  const body: unknown = await request.json().catch(() => undefined)
  if (
    body !== null &&
    typeof body === "object" &&
    "jobIds" in body &&
    body.jobIds !== undefined
  ) {
    const raw: unknown = body.jobIds
    if (!Array.isArray(raw)) {
      return Response.json(
        {
          error: {
            code: "invalid_job_ids",
            message: "jobIds must be an array of Job UUIDs.",
          },
        },
        { status: 400 }
      )
    }
    const invalid = raw.some(
      (value) => typeof value !== "string" || !UUID_JOB_RE.test(value)
    )
    if (invalid) {
      return Response.json(
        {
          error: {
            code: "invalid_job_ids",
            message: "jobIds must be an array of Job UUIDs.",
          },
        },
        { status: 400 }
      )
    }
    jobIds = raw.filter((value): value is string => typeof value === "string")
  }

  const jobFilter =
    jobIds.length > 0
      ? sql` AND j.id IN (${sql.join(
          jobIds.map((jobId) => sql`${jobId}::uuid`),
          sql`, `
        )})`
      : sql``
  const inserted = (await db.execute(sql`
    INSERT INTO job_retries (store_id, import_id, job_id)
    SELECT ${DEFAULT_STORE_ID}, j.import_id, j.id
    FROM jobs j
    WHERE j.import_id = ${id} AND j.status = 'failed'${jobFilter}
    ON CONFLICT (job_id) DO NOTHING
    RETURNING job_id
  `)) as unknown as Array<{ job_id: string }>

  return Response.json(
    { requested: inserted.length, jobIds: inserted.map((row) => row.job_id) },
    { status: 202 }
  )
}
