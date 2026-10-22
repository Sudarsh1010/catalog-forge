"use client"

/**
 * The side-by-side review panel (user story 22 + 23): source truth on the
 * left — the Sheet Rows the Product was grouped from, its Variants, the
 * matched photos — against the AI result on the right, with every field's
 * Confidence colour-coded (GLOSSARY: Confidence) and every Claim pointing
 * at the exact row it came from (GLOSSARY: Claim). The merchant edits
 * (stored with manual Origin), approves, or sends the Product back from
 * here; approval writes Publications (ADR-0005).
 */
import { useCallback, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ProductDetailDto } from "@workspace/contracts"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { cn } from "@workspace/ui/lib/utils"

import { orpc } from "@/lib/orpc"
import {
  CONFIDENCE_FIELDS,
  PRODUCT_STATUS_STYLES,
  confidenceBucket,
  CONFIDENCE_STYLES,
} from "./import-labels"

const ACTION_ERROR = "The action could not be completed — try again."

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/** One coloured Confidence chip (per-field, user story 21). */
function ConfidenceChip({
  field,
  label,
  score,
}: {
  field: string
  label: string
  score: number | undefined
}) {
  if (score === undefined) {
    return (
      <span
        className="text-[11px] text-muted-foreground"
        title={`${label}: no score`}
      >
        {label} —
      </span>
    )
  }
  return (
    <Badge
      variant="secondary"
      className={cn(
        "font-mono text-[11px]",
        CONFIDENCE_STYLES[confidenceBucket(score)]
      )}
      title={`${label}: ${score}/100`}
    >
      {label} {score}
    </Badge>
  )
}

/** Textarea helper: one `key: value` per line → the attributes record. */
function parseAttributes(text: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":")
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (key.length > 0 && value.length > 0) attributes[key] = value
  }
  return attributes
}

const INPUT_CLASS =
  "w-full border border-border bg-background px-2 py-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"

export function ProductPanel({
  productId,
  onClose,
}: {
  productId: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)

  const detailQuery = useQuery(
    orpc.product.detail.queryOptions({ input: { id: productId } })
  )
  const product = detailQuery.data?.product

  const invalidate = useCallback((): void => {
    void queryClient.invalidateQueries({
      queryKey: orpc.product.detail.queryKey({ input: { id: productId } }),
    })
    void queryClient.invalidateQueries({ queryKey: orpc.product.list.key() })
  }, [productId, queryClient])

  const onError = useCallback(
    (error: unknown) => setActionError(errorMessage(error, ACTION_ERROR)),
    []
  )
  const [actionError, setActionError] = useState<string | null>(null)

  const editMutation = useMutation({
    ...orpc.product.edit.mutationOptions(),
    onSuccess: () => {
      setEditing(false)
      setActionError(null)
      invalidate()
    },
    onError,
  })
  const approveMutation = useMutation({
    ...orpc.product.approve.mutationOptions(),
    onSuccess: () => {
      setActionError(null)
      invalidate()
    },
    onError,
  })
  const sendBackMutation = useMutation({
    ...orpc.product.sendBack.mutationOptions(),
    onSuccess: () => {
      setActionError(null)
      invalidate()
    },
    onError,
  })

  if (detailQuery.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (detailQuery.isError || !product) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription className="text-xs">
          This product could not be loaded — it may have been removed.
        </AlertDescription>
      </Alert>
    )
  }

  const status =
    PRODUCT_STATUS_STYLES[product.status] ?? PRODUCT_STATUS_STYLES.pending!
  const enrichment = product.enrichment
  const busy =
    editMutation.isPending ||
    approveMutation.isPending ||
    sendBackMutation.isPending

  return (
    <div className="flex min-w-0 flex-col gap-4" aria-label="Product review">
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 flex-1 text-sm font-medium break-words">
            {enrichment?.title ?? product.naturalKey}
          </h2>
          <Badge variant="secondary" className={status.className}>
            {status.label}
          </Badge>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            aria-label="Close review panel"
          >
            ✕
          </Button>
        </div>
        <p className="font-mono text-[11px] text-muted-foreground">
          {product.naturalKey} · {product.importFilename}
        </p>
        {product.publication ? (
          <p className="text-[11px] text-emerald-700 dark:text-emerald-400">
            Published ({product.publication.locales.join(", ")}){" "}
            {new Date(product.publication.publishedAt).toLocaleString(
              undefined,
              { dateStyle: "short", timeStyle: "short" }
            )}
          </p>
        ) : null}
        {actionError ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription className="text-xs">
              {actionError}
            </AlertDescription>
          </Alert>
        ) : null}
        {enrichment && enrichment.reviewReasons.length > 0 ? (
          <Alert
            role="status"
            className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 [&>svg]:text-current"
          >
            <AlertDescription className="text-xs">
              {enrichment.reviewReasons.join(" ")}
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="xs"
            disabled={busy || !enrichment || product.status === "approved"}
            onClick={() => approveMutation.mutate({ id: product.id })}
          >
            {approveMutation.isPending ? "Publishing…" : "Approve"}
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={busy || !enrichment}
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? "Cancel edit" : "Edit"}
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => sendBackMutation.mutate({ id: product.id })}
          >
            {sendBackMutation.isPending ? "Sending back…" : "Send back"}
          </Button>
        </div>
        {sendBackMutation.isSuccess ? (
          <p className="text-[11px] text-muted-foreground" role="status">
            Sent back — re-enrichment queued; the worker picks it up like any
            re-run.
          </p>
        ) : null}
        {approveMutation.isSuccess ? (
          <p
            className="text-[11px] text-emerald-700 dark:text-emerald-400"
            role="status"
          >
            Approved — Publications written for{" "}
            {approveMutation.data?.publishedLocales.join(", ")}.
          </p>
        ) : null}
      </header>

      {editing && enrichment ? (
        <EditForm
          product={{ ...product, enrichment }}
          busy={editMutation.isPending}
          onSave={(fields) => editMutation.mutate({ id: product.id, fields })}
        />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---------------------------------------------------- source */}
        <section className="flex min-w-0 flex-col gap-3" aria-label="Source">
          <h3 className="text-xs font-medium text-muted-foreground">
            Source — sheet rows, variants, photos
          </h3>
          {product.sourceRows.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b">
                    <th className="py-1 pr-2 text-left font-medium">Row</th>
                    {product.sheetHeader.map((column) => (
                      <th
                        key={column}
                        className="py-1 pr-2 text-left font-medium"
                      >
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {product.sourceRows.map((row) => (
                    <tr
                      key={row.rowIndex}
                      id={`source-row-${row.rowIndex}`}
                      className="border-b border-border/50 align-top"
                    >
                      <td className="py-1 pr-2 font-mono text-muted-foreground">
                        {row.rowIndex}
                      </td>
                      {product.sheetHeader.map((column, index) => (
                        <td key={column} className="py-1 pr-2 break-words">
                          {cellText(row.cells[index])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              No sheet rows recorded for this product.
            </p>
          )}

          {product.variants.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b">
                    <th className="py-1 pr-2 text-left font-medium">SKU</th>
                    <th className="py-1 pr-2 text-left font-medium">GTIN</th>
                    <th className="py-1 pr-2 text-left font-medium">Price</th>
                    <th className="py-1 pr-2 text-left font-medium">
                      Attributes
                    </th>
                    <th className="py-1 text-left font-medium">Row</th>
                  </tr>
                </thead>
                <tbody>
                  {product.variants.map((variant) => (
                    <tr key={variant.id} className="border-b border-border/50">
                      <td className="py-1 pr-2 font-mono">
                        {variant.sku ?? "—"}
                      </td>
                      <td className="py-1 pr-2 font-mono">
                        {variant.gtin ?? "—"}
                      </td>
                      <td className="py-1 pr-2 tabular-nums">
                        {variant.priceCents !== null && variant.priceCurrency
                          ? `${(variant.priceCents / 100).toFixed(2)} ${variant.priceCurrency}`
                          : "—"}
                      </td>
                      <td className="py-1 pr-2">
                        {Object.entries(variant.attributes)
                          .map(([key, value]) => `${key}: ${value}`)
                          .join(" · ") || "—"}
                      </td>
                      <td className="py-1 font-mono text-muted-foreground">
                        {variant.sourceRowIndex}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {product.photos.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {product.photos.map((photo) => (
                <figure key={photo.fileId} className="flex w-24 flex-col gap-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/photos/${photo.fileId}`}
                    alt={photo.filename}
                    loading="lazy"
                    className="h-24 w-24 border border-border object-cover"
                  />
                  <figcaption className="text-[10px] break-all text-muted-foreground">
                    {photo.filename}
                    <span className="block">
                      matched via {photo.matchedVia} “{photo.matchedToken}”
                    </span>
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              No matched photos.
            </p>
          )}
        </section>

        {/* ------------------------------------------------- AI result */}
        <section className="flex min-w-0 flex-col gap-3" aria-label="AI result">
          <h3 className="text-xs font-medium text-muted-foreground">
            AI result —{" "}
            {enrichment ? `messiness ${enrichment.messiness}` : "not enriched"}
          </h3>
          {!enrichment ? (
            <p className="text-[11px] text-muted-foreground">
              The enrich stage has not run for this product yet.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1">
                {CONFIDENCE_FIELDS.map(({ key, label }) => (
                  <ConfidenceChip
                    key={key}
                    field={key}
                    label={label}
                    score={enrichment.confidence[key]}
                  />
                ))}
              </div>
              <dl className="flex flex-col gap-2 text-xs">
                <Field label="Title" origin={enrichment.fieldOrigins.title}>
                  {enrichment.title}
                </Field>
                <Field label="Handle" origin={enrichment.fieldOrigins.handle}>
                  <span className="font-mono">{enrichment.handle}</span>
                </Field>
                <Field
                  label="Description"
                  origin={enrichment.fieldOrigins.description}
                >
                  {enrichment.description || (
                    <span className="text-muted-foreground">—</span>
                  )}
                </Field>
                <Field
                  label="Category"
                  origin={enrichment.fieldOrigins.category}
                >
                  {enrichment.category || (
                    <span className="text-muted-foreground">—</span>
                  )}
                </Field>
                <Field label="Tags" origin={enrichment.fieldOrigins.tags}>
                  {enrichment.tags.length > 0
                    ? enrichment.tags.join(", ")
                    : "—"}
                </Field>
                <Field
                  label="Attributes"
                  origin={enrichment.fieldOrigins.attributes}
                >
                  {Object.keys(enrichment.attributes).length > 0
                    ? Object.entries(enrichment.attributes)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(" · ")
                    : "—"}
                </Field>
              </dl>
              {enrichment.claims.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <h4 className="text-xs font-medium">Claims</h4>
                  <ul className="flex flex-col gap-1">
                    {enrichment.claims.map((claim, index) => (
                      <li
                        key={`${claim.sourceRowIndex}-${index}`}
                        className="flex items-start gap-2 text-xs"
                      >
                        <button
                          type="button"
                          className="shrink-0 font-mono text-[11px] text-primary underline underline-offset-2"
                          onClick={() => {
                            document
                              .getElementById(
                                `source-row-${claim.sourceRowIndex}`
                              )
                              ?.scrollIntoView({ block: "center" })
                          }}
                          title="Jump to the source row"
                        >
                          Row {claim.sourceRowIndex}
                        </button>
                        <span className="min-w-0 break-words">
                          {claim.text}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  No claims extracted — nothing asserted beyond the source
                  fields.
                </p>
              )}
              {product.translations.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <h4 className="text-xs font-medium">Translations</h4>
                  <ul className="flex flex-col gap-0.5 text-[11px]">
                    {product.translations.map((translation) => (
                      <li key={`${translation.locale}-${translation.field}`}>
                        <span className="font-mono uppercase">
                          {translation.locale}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          {translation.field}:
                        </span>{" "}
                        {translation.text}{" "}
                        <Badge
                          variant="secondary"
                          className={cn(
                            "text-[10px]",
                            translation.origin === "manual"
                              ? "bg-blue-500/15 text-blue-700 dark:text-blue-400"
                              : "bg-muted text-muted-foreground"
                          )}
                        >
                          {translation.origin === "manual" ? "merchant" : "AI"}
                        </Badge>
                        {translation.outOfDate ? (
                          <Badge
                            variant="secondary"
                            className="ml-1 bg-amber-500/15 text-[10px] text-amber-700 dark:text-amber-400"
                          >
                            out of date
                          </Badge>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function cellText(cell: string | number | boolean | null | undefined): string {
  if (cell === null || cell === undefined) return ""
  return String(cell)
}

/** One enriched field with its Origin badge (manual = merchant won). */
function Field({
  label,
  origin,
  children,
}: {
  label: string
  origin: "ai" | "manual" | undefined
  children: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {label}
        {origin === "manual" ? (
          <Badge
            variant="secondary"
            className="bg-blue-500/15 text-[10px] text-blue-700 dark:text-blue-400"
            title="Edited by the merchant — wins over later AI output"
          >
            merchant
          </Badge>
        ) : null}
      </dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

/**
 * The inline edit form: the six enriched fields. Saving records manual
 * Origin per edited field — the merchant's wording beats every later AI
 * output for this Product.
 */
function EditForm({
  product,
  busy,
  onSave,
}: {
  /** Detail with a guaranteed enrichment (the form edits its fields). */
  product: ProductDetailDto & {
    enrichment: NonNullable<ProductDetailDto["enrichment"]>
  }
  busy: boolean
  onSave: (fields: {
    title?: string
    handle?: string
    description?: string
    category?: string
    tags?: string[]
    attributes?: Record<string, string>
  }) => void
}) {
  const enrichment = product.enrichment!
  const [title, setTitle] = useState(enrichment.title)
  const [handle, setHandle] = useState(enrichment.handle)
  const [description, setDescription] = useState(enrichment.description)
  const [category, setCategory] = useState(enrichment.category)
  const [tags, setTags] = useState(enrichment.tags.join(", "))
  const [attributes, setAttributes] = useState(
    Object.entries(enrichment.attributes)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n")
  )
  const [include, setInclude] = useState<ReadonlySet<string>>(new Set())

  const toggle = useCallback((field: string): void => {
    setInclude((previous) => {
      const next = new Set(previous)
      if (next.has(field)) next.delete(field)
      else next.add(field)
      return next
    })
  }, [])

  const submit = (): void => {
    const fields: Parameters<typeof onSave>[0] = {}
    if (include.has("title") && title !== enrichment.title) {
      fields.title = title
    }
    if (include.has("handle") && handle !== enrichment.handle) {
      fields.handle = handle
    }
    if (include.has("description") && description !== enrichment.description) {
      fields.description = description
    }
    if (include.has("category") && category !== enrichment.category) {
      fields.category = category
    }
    if (include.has("tags")) {
      fields.tags = tags
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
    }
    if (include.has("attributes")) {
      fields.attributes = parseAttributes(attributes)
    }
    onSave(fields)
  }

  const changed = (field: string, value: string, original: string): void => {
    setInclude((previous) => {
      const next = new Set(previous)
      if (value !== original) next.add(field)
      else next.delete(field)
      return next
    })
    if (field === "title") setTitle(value)
    if (field === "handle") setHandle(value)
    if (field === "description") setDescription(value)
    if (field === "category") setCategory(value)
  }

  return (
    <form
      className="flex flex-col gap-2 border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <p className="text-[11px] text-muted-foreground">
        Changed fields save as merchant edits (manual Origin) and win over later
        AI output.
      </p>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Title</span>
        <input
          className={INPUT_CLASS}
          value={title}
          onChange={(event) =>
            changed("title", event.target.value, enrichment.title)
          }
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Handle</span>
        <input
          className={INPUT_CLASS}
          value={handle}
          onChange={(event) =>
            changed("handle", event.target.value, enrichment.handle)
          }
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Description</span>
        <textarea
          className={cn(INPUT_CLASS, "min-h-20")}
          value={description}
          onChange={(event) =>
            changed("description", event.target.value, enrichment.description)
          }
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Category</span>
        <input
          className={INPUT_CLASS}
          value={category}
          onChange={(event) =>
            changed("category", event.target.value, enrichment.category)
          }
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Tags (comma-separated)</span>
        <input
          className={INPUT_CLASS}
          value={tags}
          onChange={(event) => {
            setTags(event.target.value)
            setInclude((previous) =>
              previous.has("tags") ||
              event.target.value !== enrichment.tags.join(", ")
                ? new Set([...previous, "tags"])
                : previous
            )
          }}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">
          Attributes (one `name: value` per line)
        </span>
        <textarea
          className={cn(INPUT_CLASS, "min-h-16")}
          value={attributes}
          onChange={(event) => {
            setAttributes(event.target.value)
            setInclude((previous) =>
              previous.has("attributes") ||
              event.target.value !==
                Object.entries(enrichment.attributes)
                  .map(([key, value]) => `${key}: ${value}`)
                  .join("\n")
                ? new Set([...previous, "attributes"])
                : previous
            )
          }}
        />
      </label>
      <div className="flex items-center gap-2">
        <Button type="submit" size="xs" disabled={busy || include.size === 0}>
          {busy
            ? "Saving…"
            : `Save ${include.size} edited ${include.size === 1 ? "field" : "fields"}`}
        </Button>
        {include.size === 0 ? (
          <span className="text-[11px] text-muted-foreground">
            Change a field to enable saving.
          </span>
        ) : null}
      </div>
    </form>
  )
}
