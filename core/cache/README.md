# @workspace/cache

Redis client (ioredis), as a pure factory.

## Usage

```ts
import { createCache } from "@workspace/cache"

const { redis, close } = createCache({
  url: process.env.REDIS_URL,
  keyPrefix: "catalog-forge:",
})
await redis.set("session:1", payload, "EX", 60)
await close()
```

- `lazyConnect` defaults to `true` — creating a cache at module scope never
  opens a connection until the first command.
- The web app uses the `getCache()` singleton in `platform/app/lib/cache.ts`;
  the worker should create its own instance.
