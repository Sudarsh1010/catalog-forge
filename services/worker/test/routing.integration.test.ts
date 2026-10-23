/**
 * Per-row routing integration tests (spec #12): the model tier for EACH
 * enrich call comes from that Product's enrich-time photo-aware Messiness
 * Score — clean rows in a mixed Batch route fast even when the Batch's Job
 * carries the strong stamp, and a row that only crosses the threshold via
 * its photos routes strong even though its plan-time score stayed fast.
 * The Job's routing_tier/provider_id stamp remains claim-gate/Pause
 * metadata only (a Pause holds the whole Batch under its neediest tier's
 * provider); matched photos ride to the provider as real bytes.
 */
import { readFileSync } from "node:fs"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"
import type { Storage } from "@workspace/storage"
import { enrichBatchKey } from "@workspace/pipeline"

import { createEnrichHandler } from "../src/enrich/handler.js"
import {
  createProviderRegistry,
  createWorker,
  defineHandlers,
} from "../src/index.js"
import type { Provider, ProviderRegistry, RoutingTier } from "../src/index.js"
import {
  connectTestDb,
  createTestDatabase,
  dropTestDatabase,
  putTestObject,
  seedImport,
  seedImportFile,
  testStorage,
  waitFor,
} from "./helpers"

let db: Db
let storage: Storage

beforeAll(async () => {
  await createTestDatabase()
  db = connectTestDb()
  storage = testStorage()
})

beforeEach(async () => {
  await db.db.execute(
    sql`TRUNCATE translation_memory, jobs, imports, sheet_rows, import_files,
        products, variants, product_enrichments, provider_usage, row_ledger CASCADE`
  )
})

afterAll(async () => {
  await db.close()
  await dropTestDatabase()
})

const STORE = "test-store"

interface SeedProductOptions {
  naturalKey: string
  identityKind: "code" | "title"
  description: string | null
  category: string | null
  gtin: string | null
  variantCount: number
}

async function seedProduct(
  importId: string,
  options: SeedProductOptions
): Promise<string> {
  const id = crypto.randomUUID()
  await db.db.execute(sql`
    INSERT INTO products (id, store_id, import_id, family_key, identity_kind,
                          natural_key, natural_key_hash, title, description,
                          category, brand, gtin)
    VALUES (${id}, ${STORE}, ${importId},
            (SELECT family_key FROM imports WHERE id = ${importId}),
            ${options.identityKind}, ${options.naturalKey}, ${id},
            'Test ' || ${id.slice(0, 8)}, ${options.description},
            ${options.category}, 'Brunner', ${options.gtin})
  `)
  for (let index = 0; index < options.variantCount; index++) {
    await db.db.execute(sql`
      INSERT INTO variants (store_id, import_id, product_id, variant_key,
                            variant_key_hash, source_row_index, needs_review)
      VALUES (${STORE}, ${importId}, ${id}, ${"v" + index},
              ${crypto.randomUUID()}, ${index + 1}, false)
    `)
  }
  return id
}

/** A committed eval photo, matched to the Product, bytes in object storage. */
async function seedPhoto(
  importId: string,
  productId: string,
  filename: string,
  bytes: Buffer
): Promise<void> {
  const objectKey = `t2-tests/${importId}/photos/${filename}`
  await putTestObject(storage, objectKey, bytes, "image/png")
  const fileId = await seedImportFile(db, {
    importId,
    kind: "photo",
    objectKey,
    filename,
    contentType: "image/png",
    sizeBytes: bytes.byteLength,
  })
  await db.db.execute(sql`
    INSERT INTO product_photos (store_id, import_id, import_file_id,
                                product_id, matched_via, matched_token)
    VALUES (${STORE}, ${importId}, ${fileId}, ${productId}, 'sku',
            ${filename.split(".")[0]})
  `)
}

function evalPhoto(name: string): Buffer {
  return readFileSync(new URL(`../../../eval/photos/${name}`, import.meta.url))
}

// ----------------------------------------------------- recording registry --

interface RecordedCall {
  tier: RoutingTier
  naturalKey: string
  messiness: number
  photoCount: number
  photos: number
  bytes: number
}

/**
 * One provider instance per tier, recording what each tier was asked. The
 * registry itself does the real tier→provider resolution, so a call showing
 * up under `fast` means the handler routed that row fast.
 */
function recordingRegistry(calls: RecordedCall[]): ProviderRegistry {
  const providerFor = (tier: RoutingTier): Provider => ({
    id: "recorder",
    async enrich(input) {
      calls.push({
        tier,
        naturalKey: input.product.naturalKey,
        messiness: input.messiness,
        photoCount: input.photoCount,
        photos: input.photos?.length ?? 0,
        bytes:
          input.photos?.reduce(
            (sum, photo) => sum + photo.data.byteLength,
            0
          ) ?? 0,
      })
      return {
        value: {
          title: input.product.title,
          handle: `test-${input.product.naturalKeyHash.slice(0, 8)}`,
          description: input.product.description ?? "",
          category: input.product.category ?? "",
          tags: [],
          attributes: {},
          confidence: {
            title: 95,
            handle: 95,
            description: 90,
            category: 90,
            tags: 80,
            attributes: 90,
          },
          status: "ready",
          claims: [],
          reviewReasons: [],
          sourceRows: input.sourceRows,
        },
        usage: {
          providerId: "recorder",
          model: `recorder-${tier}`,
          tokensIn: 10,
          tokensOut: 5,
        },
      }
    },
    async translate() {
      throw new Error("routing tests never translate")
    },
  })
  return createProviderRegistry([
    { provider: providerFor("fast"), concurrency: 4, tiers: ["fast"] },
    { provider: providerFor("strong"), concurrency: 4, tiers: ["strong"] },
  ])
}

async function runEnrichBatch(
  importId: string,
  registry: ProviderRegistry
): Promise<void> {
  const worker = createWorker({
    db,
    handlers: defineHandlers({
      enrich: createEnrichHandler({ registry, storage }),
    }),
    config: { workerId: "w-routing", claimIntervalMs: 10, sweepIntervalMs: 25 },
  })
  worker.start()
  try {
    await waitFor("the enrich Batch completed", async () => {
      const rows = (await db.db.execute(sql`
        SELECT status::text AS status FROM jobs
        WHERE import_id = ${importId} AND stage = 'enrich'
      `)) as unknown as Array<{ status: string }>
      return rows.length === 1 && rows[0]!.status === "completed"
    })
    await waitFor("every Product enriched", async () => {
      const rows = (await db.db.execute(sql`
        SELECT count(*)::int AS count FROM product_enrichments
        WHERE import_id = ${importId}
      `)) as unknown as Array<{ count: number }>
      return rows[0]!.count === 3
    })
  } finally {
    await worker.stop()
  }
}

describe("per-row enrich routing in a mixed Batch (spec #12)", () => {
  it("routes clean rows fast and messy/photo rows strong under a strong-stamped Job", async () => {
    const imp = await seedImport(db, { stage: "enrich", status: "running" })

    // Clean: every field present, one variant → score 2 (the variant term).
    await seedProduct(imp.id, {
      naturalKey: "sku:clean-01",
      identityKind: "code",
      description: "Robuste Gießkanne aus Stahlblech.",
      category: "Garten > Bewässerung",
      gtin: "4000000000001",
      variantCount: 1,
    })
    // Messy: title identity (+30), no description (+20), no category (+15)
    // → 65, strong at plan time already.
    await seedProduct(imp.id, {
      naturalKey: "sku:messy-01",
      identityKind: "title",
      description: null,
      category: null,
      gtin: "4000000000002",
      variantCount: 0,
    })
    // Photo-only: title identity (+30), no gtin (+10), two variants (+4)
    // → 44 (fast at plan time); three matched photos add 3×2 → 50 at
    // enrich time — strong only via the photo term.
    const photoProductId = await seedProduct(imp.id, {
      naturalKey: "sku:photo-only-01",
      identityKind: "title",
      description: "Strohhut mit breiter Krempe.",
      category: "Garten > Sonstiges",
      gtin: null,
      variantCount: 2,
    })
    const photos: Array<[string, Buffer]> = [
      ["gk-2-01.png", evalPhoto("gk-2-01.png")],
      ["kb-50-01.png", evalPhoto("kb-50-01.png")],
      ["tp-100-rot-01.png", evalPhoto("tp-100-rot-01.png")],
    ]
    for (const [filename, bytes] of photos) {
      await seedPhoto(imp.id, photoProductId, filename, bytes)
    }

    // The planner's stamp for this mixed Batch: the neediest product's tier
    // plus the provider serving it (what the Pause claim gate holds the
    // Batch under). Claim-gate metadata only — it must not pick models.
    await db.db.execute(sql`
      INSERT INTO jobs (store_id, import_id, stage, batch_key,
                        provider_id, routing_tier)
      VALUES (${STORE}, ${imp.id}, 'enrich', ${enrichBatchKey(1, 3)},
              'recorder', 'strong')
    `)

    const calls: RecordedCall[] = []
    await runEnrichBatch(imp.id, recordingRegistry(calls))
    expect(calls).toHaveLength(3)
    const byKey = new Map(calls.map((call) => [call.naturalKey, call]))

    // Clean row: fast, despite the Batch's strong stamp.
    const clean = byKey.get("sku:clean-01")!
    expect(clean.tier).toBe("fast")
    expect(clean.messiness).toBe(2)
    expect(clean.photos).toBe(0)

    // Messy row: strong, no photos of its own.
    const messy = byKey.get("sku:messy-01")!
    expect(messy.tier).toBe("strong")
    expect(messy.messiness).toBe(65)
    expect(messy.photos).toBe(0)

    // Photo-only row: strong via the photo term, and its matched photos
    // ride along as real bytes for the strong tier's vision.
    const photoOnly = byKey.get("sku:photo-only-01")!
    expect(photoOnly.tier).toBe("strong")
    expect(photoOnly.messiness).toBe(50)
    expect(photoOnly.photoCount).toBe(3)
    expect(photoOnly.photos).toBe(3)
    expect(photoOnly.bytes).toBe(
      photos.reduce((sum, [, bytes]) => sum + bytes.byteLength, 0)
    )

    // The enrich-time scores landed on the enrichments (translate's
    // per-item routing input).
    const rows = (await db.db.execute(sql`
      SELECT messiness FROM product_enrichments WHERE import_id = ${imp.id}
    `)) as unknown as Array<{ messiness: number }>
    expect(rows.map((row) => row.messiness).sort((a, b) => a - b)).toEqual([
      2, 50, 65,
    ])
  })
})
