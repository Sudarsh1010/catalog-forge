"use client"

/**
 * Drag-and-drop upload surface: a sheet (CSV/XLSX) plus photos as loose
 * files or one ZIP. The request streams to storage and returns an
 * acknowledgment immediately; progress comes from the import queue's SSE.
 */
import { useCallback, useRef, useState, type DragEvent } from "react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import type { ImportDto } from "@/lib/imports"

export interface UploadResult {
  import: ImportDto
  deduped: boolean
}

const SHEET_PATTERN = /\.(csv|xlsx)$/i
const ZIP_PATTERN = /\.zip$/i
const PHOTO_PATTERN = /\.(jpe?g|png|webp|gif|avif|heic|heif|tiff?|bmp)$/i

export function UploadDropzone({
  onUploaded,
}: {
  onUploaded: (result: UploadResult) => void
}): React.ReactElement {
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const sendFiles = useCallback(
    async (files: File[]): Promise<void> => {
      const sheet = files.find((file) => SHEET_PATTERN.test(file.name))
      const zip = files.find((file) => ZIP_PATTERN.test(file.name))
      const photos = files.filter((file) => PHOTO_PATTERN.test(file.name))
      if (!sheet && !zip) {
        setError(
          "Drop a supplier sheet (CSV or XLSX) — photos ride along as files or one ZIP."
        )
        return
      }
      const form = new FormData()
      if (sheet) form.append("sheet", sheet)
      for (const photo of photos) form.append("photos", photo)
      if (zip) form.append("zip", zip)

      setBusy(true)
      setError(null)
      try {
        const response = await fetch("/api/imports", {
          method: "POST",
          body: form,
        })
        const payload = (await response.json()) as {
          import?: ImportDto
          deduped?: boolean
          error?: { message: string }
        }
        if (!response.ok || !payload.import) {
          setError(
            payload.error?.message ??
              "The upload was rejected. Check the files and try again."
          )
          return
        }
        onUploaded({
          import: payload.import,
          deduped: payload.deduped === true,
        })
      } catch {
        setError("The upload failed before it reached the server — try again.")
      } finally {
        setBusy(false)
      }
    },
    [onUploaded]
  )

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDragging(false)
      void sendFiles([...event.dataTransfer.files])
    },
    [sendFiles]
  )

  return (
    <div className="flex flex-col gap-2">
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload a sheet and photos"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ")
            inputRef.current?.click()
        }}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex min-h-36 cursor-pointer flex-col items-center justify-center gap-1 border border-dashed border-border bg-muted/30 px-6 py-8 text-center transition-colors",
          dragging && "border-primary bg-primary/5",
          busy && "pointer-events-none opacity-60"
        )}
      >
        <p className="text-sm font-medium">
          {busy
            ? "Uploading…"
            : "Drop your supplier sheet here — photos as files or one ZIP"}
        </p>
        <p className="text-xs text-muted-foreground">
          CSV or XLSX up to 100 MB · images or a ZIP up to 500 MB
        </p>
        <Button className="mt-2" variant="outline" size="sm" tabIndex={-1}>
          Choose files
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".csv,.xlsx,image/*,.zip"
          className="hidden"
          onChange={(event) => {
            void sendFiles([...(event.target.files ?? [])])
            event.target.value = ""
          }}
        />
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
