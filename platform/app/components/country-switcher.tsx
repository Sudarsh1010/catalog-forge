/**
 * Country switcher — plain links so the storefront stays server-rendered
 * (ADR-0005: reads are cheap and never touch anything but Publications).
 * Selecting a country re-renders the current page in the mapped locale:
 * Germany/Austria → German, France → French, everyone else English.
 */
import Link from "next/link"

import {
  COUNTRIES,
  COUNTRY_LABELS,
  resolveLocale,
  type StoreLocale,
} from "@/lib/storefront"
import { cn } from "@workspace/ui/lib/utils"

export function CountrySwitcher({
  country,
  pathname,
}: {
  /** The active `?country=` value (may be absent = rest of world). */
  country: string | undefined
  /** The current path, preserved by every switcher link. */
  pathname: string
}) {
  const active = resolveLocale(country)

  return (
    <nav
      aria-label="Country"
      className="flex flex-wrap items-center gap-2 text-xs"
    >
      {COUNTRIES.map((code) => {
        const locale = resolveLocale(code)
        const selected = locale === active
        const href = code === "GB" ? pathname : `${pathname}?country=${code}`
        return (
          <Link
            key={code}
            href={href}
            aria-current={selected ? "true" : undefined}
            className={cn(
              "rounded-full px-3 py-1 ring-1 ring-foreground/15 transition-colors",
              selected
                ? "bg-foreground text-background"
                : "hover:bg-foreground/5"
            )}
          >
            {COUNTRY_LABELS[code]}
          </Link>
        )
      })}
    </nav>
  )
}
