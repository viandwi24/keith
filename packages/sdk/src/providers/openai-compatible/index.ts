/** The OpenAI-compatible LLM helper that provider plugins configure (ADR-0008). */
export { createOpenAICompatibleLlm, type OpenAICompatibleLlmOptions } from './provider.ts'
export { fromWireToolName, toWireToolName } from './wire.ts'
