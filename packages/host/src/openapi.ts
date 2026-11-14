import { z } from 'zod'
import type { ResolvedOperation } from './types.ts'

/** A JSON object of the OpenAPI document (plain data; the test pins it as a golden file). */
export type JsonObject = Record<string, unknown>

export interface OpenApiOptions {
  title?: string
  version?: string
  description?: string
}

const ERROR_SCHEMA: JsonObject = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } },
      required: ['code', 'message'],
      additionalProperties: false,
    },
  },
  required: ['error'],
  additionalProperties: false,
}

const errorResponse = (description: string): JsonObject => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
})

/**
 * One JSON Schema of a zod schema, for the OpenAPI document (3.1 speaks JSON Schema 2020-12). Definitions
 * (`$defs`, from recursive schemas) move to `components.schemas` under a name unique to the operation.
 */
function schemaOf(
  schema: z.ZodType,
  io: 'input' | 'output',
  prefix: string,
  components: Record<string, unknown>,
): JsonObject {
  const raw = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as JsonObject
  const { $schema: _dropped, $defs, ...rest } = raw
  const defs = ($defs ?? {}) as Record<string, unknown>
  const root = `#/components/schemas/${prefix}_root`
  const rewrite = (value: unknown): unknown =>
    JSON.parse(
      Object.keys(defs)
        .reduce(
          (text, name) =>
            text.replaceAll(`"#/$defs/${name}"`, `"#/components/schemas/${prefix}_${name}"`),
          JSON.stringify(value),
        )
        // zod writes a schema that refers to itself as `$ref: "#"`: inside a document that is the wrong root
        .replaceAll('"$ref":"#"', `"$ref":"${root}"`),
    )
  const selfRef = JSON.stringify(rest).includes('"$ref":"#"')
  for (const [name, def] of Object.entries(defs)) components[`${prefix}_${name}`] = rewrite(def)
  if (selfRef) {
    components[`${prefix}_root`] = rewrite(rest)
    return { $ref: root }
  }
  return rewrite(rest) as JsonObject
}

/**
 * The OpenAPI 3.1 document of a set of operations (docs/specs/plugins.md, "HTTP and OpenAPI"). Pure: the
 * caller decides which operations (the ones visible to the person asking). Order is the order given, so
 * the same plugins give the same bytes.
 */
export function buildOpenApi(
  operations: readonly ResolvedOperation[],
  options: OpenApiOptions = {},
): JsonObject {
  const paths: Record<string, unknown> = {}
  const schemas: Record<string, unknown> = { Error: ERROR_SCHEMA }
  for (const op of operations) {
    const prefix = `${op.pluginId.replaceAll('-', '_')}_${op.name}`
    paths[op.route] = {
      post: {
        operationId: op.toolName,
        summary: op.description,
        tags: [op.pluginId],
        'x-keith-risk': op.risk,
        'x-keith-audience': op.audience,
        'x-keith-capability': op.permission.capability,
        security: [{ bearer: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: schemaOf(op.input, 'input', `${prefix}_in`, schemas) },
          },
        },
        responses: {
          '200': {
            description: 'The operation output.',
            content: {
              'application/json': {
                schema: schemaOf(op.output, 'output', `${prefix}_out`, schemas),
              },
            },
          },
          '400': errorResponse('The input is not valid.'),
          '401': errorResponse('Missing or invalid credential.'),
          '404': errorResponse('Not found or not permitted (the same answer for both).'),
          '429': errorResponse('Too many calls; see Retry-After.'),
        },
      },
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: options.title ?? 'Keith plugins',
      version: options.version ?? '1',
      ...(options.description === undefined ? {} : { description: options.description }),
    },
    paths,
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas,
    },
  }
}
