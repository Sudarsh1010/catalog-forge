import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  experimental: {
    agentUpgrade: "security",
  },
  transpilePackages: [
    "@workspace/cache",
    "@workspace/contracts",
    "@workspace/db",
    "@workspace/log",
    "@workspace/pipeline",
    "@workspace/storage",
    "@workspace/ui",
  ],
}

export default nextConfig
