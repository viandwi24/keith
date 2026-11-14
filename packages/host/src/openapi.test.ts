import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineKeithPlugin, defineOperation } from './define.ts'
import { buildOpenApi } from './openapi.ts'
import { echoPlugin } from './testing/index.ts'

const GOLDEN = new URL('./__golden__/echo.openapi.json', import.meta.url)

describe('buildOpenApi', () => {
  test('the document of the echo fixture matches the golden file', async () => {
    const doc = buildOpenApi(echoPlugin().operations)
    const golden = await Bun.file(GOLDEN).json()
    expect(doc).toEqual(golden)
  })

  test('one POST path per operation, from the same declaration as the tool and the route', () => {
    const plugin = echoPlugin()
    const doc = buildOpenApi(plugin.operations) as {
      paths: Record<string, { post: Record<string, unknown> }>
    }
    expect(Object.keys(doc.paths)).toEqual(plugin.operations.map((o) => o.route))
    for (const op of plugin.operations) {
      expect(doc.paths[op.route]?.post.operationId).toBe(op.toolName)
      expect(doc.paths[op.route]?.post.summary).toBe(op.description)
    }
  })

  test('a subset gives a subset: a caller sees only the operations passed', () => {
    const plugin = echoPlugin()
    const doc = buildOpenApi(plugin.operations.filter((o) => o.name === 'say')) as { paths: object }
    expect(Object.keys(doc.paths)).toEqual(['/plugins/echo/say'])
  })

  test('the schemas come from zod: required fields, limits and the output shape', () => {
    const plugin = echoPlugin()
    const doc = buildOpenApi(plugin.operations) as {
      paths: Record<
        string,
        { post: { requestBody: { content: Record<string, { schema: unknown }> } } }
      >
    }
    expect(
      doc.paths['/plugins/echo/say']?.post.requestBody.content['application/json']?.schema,
    ).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string', maxLength: 200 } },
      required: ['text'],
    })
  })

  test('a recursive schema is hoisted into components with unique names', () => {
    interface Tree {
      name: string
      children: Tree[]
    }
    const tree: z.ZodType<Tree> = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(tree) }),
    )
    const plugin = defineKeithPlugin({
      id: 'trees',
      version: '1.0.0',
      apiVersion: 1,
      operations: [
        defineOperation({
          name: 'get',
          description: 'A tree.',
          input: z.object({}),
          output: tree,
          permission: { capability: 'authenticated' },
          risk: 'read',
          run: () => ({ name: 'a', children: [] }),
        }),
      ],
    })
    const doc = buildOpenApi(plugin.operations)
    const text = JSON.stringify(doc)
    expect(text).not.toContain('#/$defs/')
    expect(text).not.toContain('"$ref":"#"')
    expect(text).toContain('#/components/schemas/trees_get_out_root')
  })

  test('the same plugins give the same bytes', () => {
    const a = JSON.stringify(buildOpenApi(echoPlugin().operations))
    const b = JSON.stringify(buildOpenApi(echoPlugin().operations))
    expect(a).toBe(b)
  })
})
