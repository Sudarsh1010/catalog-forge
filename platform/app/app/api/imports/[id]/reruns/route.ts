/**
 * Re-run enrichment (GLOSSARY: Re-run): the app writes the FACT — one
 * `reruns` row carrying the chosen Products — and the Worker's Sweeper
 * adopts it by requeuing the enrich Jobs whose Batches cover those Products
 * with reset attempts (ADR-0004: the app never touches Job machinery).
 *
 * POST /api/imports/:id/reruns   body: { productIds: string[] }
 * Idempotent downstream: a second fact for already-pending Jobs requeues
 * nothing, so double-clicks are harmless.
 */
import { eq, sql } from "drizzle-orm"

import { DEFAULT_STORE_ID } from "@workspace/pipeline"
import { imports } from "@workspace/db/schema"

import { getDb } from "@/lib/db"
import { UUID_RE } from "@/lib/imports"

export const runtime = "nodejs"

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

  const body: unknown = await request.json().catch(() => undefined)
  let raw: unknown
  if (body !== null && typeof body === "object" && "productIds" in body) {
    raw = body.productIds // unknown — validated below
  }
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.some((value) => typeof value !== "string" || !UUID_RE.test(value))
  ) {
    return Response.json(
      {
        error: {
          code: "invalid_product_ids",
          message: "productIds must be a non-empty array of Product UUIDs.",
        },
      },
      { status: 400 }
    )
  }
  const productIds = [...new Set(raw as string[])]

  // Only Products of THIS Import are re-runnable — reject cross-Import ids
  // instead of adopting facts the Worker would silently no-op.
  const known = (await db.execute(sql`
    SELECT count(*)::int AS count FROM products
    WHERE import_id = ${id}
      AND id IN (${sql.join(
        productIds.map((productId) => sql`${productId}::uuid`),
        sql`, `
      )})
  `)) as unknown as Array<{ count: number }>
  if (known[0]!.count !== productIds.length) {
    return Response.json(
      {
        error: {
          code: "unknown_products",
          message:
            "Some products do not belong to this import — refresh the page and try again.",
        },
      },
      { status: 422 }
    )
  }

  await db.execute(sql`
    INSERT INTO reruns (store_id, import_id, stage, product_ids)
    VALUES (
      ${DEFAULT_STORE_ID},
      ${id},
      'enrich',
      ARRAY[${sql.join(
        productIds.map((productId) => sql`${productId}::uuid`),
        sql`, `
      )}]::uuid[]
    )
  `)

  return Response.json(
    { requested: productIds.length, productIds, stage: "enrich" },
    { status: 202 }
  )
}
