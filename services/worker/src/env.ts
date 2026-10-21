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
