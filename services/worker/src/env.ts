/** Missing environment variable — the Worker's loud boot failure. */
export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Export it in your shell (values live in the repo-root .env.example) and try again.`
    )
  }
  return value
}

/** Optional integer env with a fallback — loop intervals, batch sizes. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value)) {
    throw new Error(
      `Env ${name} must be an integer, got ${JSON.stringify(raw)}`
    )
  }
  return value
}

/** Optional float env with a fallback — chaos rates in [0,1]. */
export function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) {
    throw new Error(`Env ${name} must be a number, got ${JSON.stringify(raw)}`)
  }
  return value
}
