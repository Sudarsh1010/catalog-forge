/**
 * Provider port surface: the contract (port.ts), the Demo Mode stub
 * (stub.ts), the real OpenAI provider (openai.ts) and the runtime registry
 * with per-provider semaphores (registry.ts). Ticket 6's chaos stub
 * implements the same Provider port.
 */
export * from "./port"
export * from "./registry"
export { createStubProvider, STUB_PROVIDER_ID, STUB_MODEL } from "./stub"
export type { StubChaosOptions } from "./stub"
export {
  OPENAI_FAST_MODEL,
  OPENAI_PROVIDER_ID,
  OPENAI_STRONG_MODEL,
  createOpenAIProvider,
  openAIProviderEntries,
} from "./openai"
export type { OpenAIProviderOptions } from "./openai"
