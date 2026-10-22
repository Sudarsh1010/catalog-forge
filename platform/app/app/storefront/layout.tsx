/**
 * Storefront chrome: a mobile-first page frame. Read-only — every surface
 * below this layout reads Publications only (ADR-0005) and never mutates
 * anything. The country switcher lives in the pages: layouts don't see the
 * query string, and the switcher must preserve both path and country.
 */

export default function StorefrontLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 pb-16">
      <main className="flex-1">{children}</main>
    </div>
  )
}
