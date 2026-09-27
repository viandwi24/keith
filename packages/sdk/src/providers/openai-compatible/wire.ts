/**
 * The OpenAI-compatible wire shapes Keith reads (validated with zod, R-9) and the reversible
 * tool-name mapping. Schemas are loose: vendors add fields, and unknown ones are ignored.
 */
import { z } from 'zod'

const nullish = <T extends z.ZodType>(schema: T) => schema.nullish()

export const wireToolCallDeltaSchema = z.looseObject({
  index: nullish(z.number()),
  id: nullish(z.string()),
  type: nullish(z.string()),
  function: nullish(
    z.looseObject({
      name: nullish(z.string()),
      arguments: nullish(z.string()),
    }),
  ),
})
export type WireToolCallDelta = z.infer<typeof wireToolCallDeltaSchema>

export const wireUsageSchema = z.looseObject({
  prompt_tokens: nullish(z.number()),
  completion_tokens: nullish(z.number()),
  prompt_tokens_details: nullish(z.looseObject({ cached_tokens: nullish(z.number()) })),
  /** DeepSeek. */
  prompt_cache_hit_tokens: nullish(z.number()),
})
export type WireUsage = z.infer<typeof wireUsageSchema>

export const wireErrorSchema = z.looseObject({
  code: nullish(z.union([z.number(), z.string()])),
  message: nullish(z.string()),
  type: nullish(z.string()),
  metadata: nullish(z.looseObject({ error_type: nullish(z.string()) })),
})
export type WireError = z.infer<typeof wireErrorSchema>

export const wireChunkSchema = z.looseObject({
  choices: nullish(
    z.array(
      z.looseObject({
        index: nullish(z.number()),
        delta: nullish(
          z.looseObject({
            content: nullish(z.string()),
            /** DeepSeek thinking mode. */
            reasoning_content: nullish(z.string()),
            /** OpenRouter normalized reasoning. */
            reasoning: nullish(z.string()),
            tool_calls: nullish(z.array(wireToolCallDeltaSchema)),
          }),
        ),
        finish_reason: nullish(z.string()),
      }),
    ),
  ),
  usage: nullish(wireUsageSchema),
  /** Mid-stream errors (OpenRouter). */
  error: nullish(wireErrorSchema),
})
export type WireChunk = z.infer<typeof wireChunkSchema>

export const wireErrorBodySchema = z.looseObject({ error: nullish(z.union([wireErrorSchema, z.string()])) })

export const wireModelsSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string(),
      /** OpenRouter. */
      context_length: nullish(z.number()),
      /** DeepSeek. */
      context_window: nullish(z.number()),
      /** OpenRouter: includes 'tools' when the model supports tool calling. */
      supported_parameters: nullish(z.array(z.string())),
    }),
  ),
})

// Tool names. Keith names are dot-separated with single underscores only (TOOL_NAME_PATTERN),
// and some vendors allow only [a-zA-Z0-9_-] in function names, so '.' ↔ '__' is reversible.

export function toWireToolName(name: string): string {
  return name.replaceAll('.', '__')
}

export function fromWireToolName(name: string): string {
  return name.replaceAll('__', '.')
}
