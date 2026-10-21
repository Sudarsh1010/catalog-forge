import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: [
    "@workspace/cache",
    "@workspace/db",
    "@workspace/log",
    "@workspace/pipeline",
    "@workspace/storage",
    "@workspace/ui",
  ],
}

export default nextConfig
