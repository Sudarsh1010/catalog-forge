"use client"

/**
 * Drag-and-drop upload surface: a sheet (CSV/XLSX) plus photos as loose
 * files or one ZIP. The multipart request streams to storage (this POST
 * stays raw — it is not part of the oRPC surface) and returns an
 * acknowledgment immediately; progress comes from the import queue's SSE.
 * On success the new Import lands in the detail cache and the queue
 * invalidates — no prop chain back to the dashboard.
 */
import { useCallback, useRef, useState, type DragEvent } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { UploadResultSchema } from "@workspace/contracts"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import { orpc } from "@/lib/orpc"

const SHEET_PATTERN = /\.(csv|xlsx)$/i
const ZIP_PATTERN = /\.zip$/i
const PHOTO_PATTERN = /\.(jpe?g|png|webp|gif|avif|heic|heif|tiff?|bmp)$/i

const UPLOAD_ERROR = "The upload was rejected. Check the files and try again."

export function UploadDropzone(): React.ReactElement {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const sheet = files.find((file) => SHEET_PATTERN.test(file.name))
      const zip = files.find((file) => ZIP_PATTERN.test(file.name))
      const photos = files.filter((file) => PHOTO_PATTERN.test(file.name))
      if (!sheet && !zip) {
        throw new Error(
          "Drop a supplier sheet (CSV or XLSX) — photos ride along as files or one ZIP."
        )
      }
      const form = new FormData()
      if (sheet) form.append("sheet", sheet)
      for (const photo of photos) form.append("photos", photo)
      if (zip) form.append("zip", zip)
      const response = await fetch("/api/imports", {
        method: "POST",
        body: form,
      })
      const payload: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        const message =
          typeof payload === "object" &&
          payload !== null &&
          "error" in payload &&
          typeof payload.error === "object" &&
          payload.error !== null &&
          "message" in payload.error &&
          typeof payload.error.message === "string"
            ? payload.error.message
            : UPLOAD_ERROR
        throw new Error(message)
      }
      const parsed = UploadResultSchema.safeParse(payload)
      if (!parsed.success) throw new Error(UPLOAD_ERROR)
      return parsed.data
    },
    onSuccess: () => {
      // The new Import appears via the refreshed queue; its detail entry
      // is fetched by the row's query (no half-shaped seeding).
      void queryClient.invalidateQueries({
        queryKey: orpc.import.list.queryKey({ input: undefined }),
      })
    },
  })

  const sendFiles = useCallback(
    (files: File[]): void => upload.mutate(files),
    [upload]
  )

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDragging(false)
      sendFiles([...event.dataTransfer.files])
    },
    [sendFiles]
  )

  const busy = upload.isPending
  const error = upload.error instanceof Error ? upload.error.message : null

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
            sendFiles([...(event.target.files ?? [])])
            event.target.value = ""
          }}
        />
      </div>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}
