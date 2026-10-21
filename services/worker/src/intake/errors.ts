/**
 * Intake failures the merchant can fix. The message is what lands in
 * `imports.failure_reason` and what the dashboard shows; `ec` ties it to the
 * edge-case catalogue (edge-cases.md) so test names and logs stay honest.
 *
 * Any other error is transient (storage, network, database) and must be
 * rethrown so the lease machinery retries it (ADR-0003).
 */
export class IntakeError extends Error {
  /** Edge-case id from edge-cases.md, when one applies. */
  readonly ec?: string

  constructor(message: string, options?: { ec?: string }) {
    super(message)
    this.name = "IntakeError"
    this.ec = options?.ec
  }
}
