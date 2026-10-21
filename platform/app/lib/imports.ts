/**
 * Import read models shared by the JSON routes and the SSE snapshot. The
 * dashboard state is read-only across the app↔worker contract (ADR-0004):
 * these shapes are what the browser sees.
 */
import type { Import } from "@workspace/db/schema"

export interface ImportDto {
  id: string
  storeId: string
  status: string
  stage: string
  originalFilename: string
  sheetFormat: string
  rowCount: number | null
  failureReason: string | null
  contentHash: string
  createdAt: string
  updatedAt: string
}

export function toImportDto(row: Import): ImportDto {
  return {
    id: row.id,
    storeId: row.storeId,
    status: row.status,
    stage: row.stage,
    originalFilename: row.originalFilename,
    sheetFormat: row.sheetFormat,
    rowCount: row.rowCount,
    failureReason: row.failureReason,
    contentHash: row.contentHash,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
