/**
 * Streams one uploaded photo out of storage for the review panels (user
 * story 22: the side-by-side view shows the source photos). The route is
 * keyed by the `import_files` id — never the raw object key, so callers
 * cannot probe arbitrary objects — and only serves `photo` files.
 */
import { GetObjectCommand } from "@aws-sdk/client-s3"
import { eq } from "drizzle-orm"

import { importFiles } from "@workspace/db/schema"

import { getDb } from "@/lib/db"
import { UUID_RE } from "@/lib/imports"
import { getStorage } from "@/lib/storage"

export const runtime = "nodejs"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ fileId: string }> }
): Promise<Response> {
  const { fileId } = await params
  if (!UUID_RE.test(fileId)) {
    return new Response("Not Found", { status: 404 })
  }

  const rows = await getDb()
    .db.select({
      kind: importFiles.kind,
      objectKey: importFiles.objectKey,
      contentType: importFiles.contentType,
    })
    .from(importFiles)
    .where(eq(importFiles.id, fileId))
    .limit(1)
  const file = rows[0]
  if (!file || file.kind !== "photo") {
    return new Response("Not Found", { status: 404 })
  }

  const storage = getStorage()
  const object = await storage.client.send(
    new GetObjectCommand({ Bucket: storage.bucket, Key: file.objectKey })
  )
  if (!object.Body) {
    return new Response("Not Found", { status: 404 })
  }
  return new Response(object.Body.transformToWebStream(), {
    headers: {
      "content-type": file.contentType ?? "application/octet-stream",
      "cache-control": "private, max-age=86400",
    },
  })
}
