import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Route tests boot `next dev` and talk plain HTTP; keep generous timeouts.
    testTimeout: 60_000,
    hookTimeout: 90_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
})
