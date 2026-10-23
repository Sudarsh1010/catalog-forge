import Link from "next/link"

import { cn } from "@workspace/ui/lib/utils"

const TABS = [
  { href: "/", label: "Imports" },
  { href: "/products", label: "Products" },
] as const

/**
 * The dashboard's two tabs (spec: Imports queue + Products review). Rendered
 * inside each page's header — deliberately not in the root layout, so the
 * storefront routes never inherit dashboard navigation.
 */
export function DashboardNav({ active }: { active: "/" | "/products" }) {
  return (
    <nav aria-label="Dashboard" className="flex w-fit gap-1">
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.href === active ? "page" : undefined}
          className={cn(
            "px-3 py-1.5 text-xs font-medium transition-colors",
            tab.href === active
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  )
}
