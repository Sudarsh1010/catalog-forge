import { createRootRoute, HeadContent, Outlet } from "@tanstack/react-router"

export const Route = createRootRoute({
  head: () => ({
    meta: [{ title: "Admin" }],
  }),
  component: () => (
    <>
      <HeadContent />
      <Outlet />
    </>
  ),
  notFoundComponent: () => <div>Not found</div>,
})
