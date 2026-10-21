/**
 * Shared S3 client factory for the two deployables (web uploads, worker
 * intake). Garage is S3-compatible and needs path-style addressing; options
 * come from the caller's environment — packages never read env themselves
 * (repo convention, see @workspace/db).
 */
import { S3Client } from "@aws-sdk/client-s3"

export interface StorageOptions {
  /** e.g. `http://127.0.0.1:9000` for the dev Garage. */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** Required for Garage/bucket-in-path style URLs. Default: true. */
  forcePathStyle?: boolean
}

export interface Storage {
  client: S3Client
  bucket: string
}

export function createStorage(options: StorageOptions): Storage {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    forcePathStyle: options.forcePathStyle ?? true,
  })
  return { client, bucket: options.bucket }
}
