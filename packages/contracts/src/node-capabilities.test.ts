import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  base64ByteLength,
  CAPABILITIES,
  CapabilityIdSchema,
  capabilityRisk,
  defineNodeCapability,
  driverOf,
  type NodeCapabilitySpec,
  NodeManifestSchema,
  SandboxRunOutputV2Schema,
  SandboxRunWireSchema,
} from './node-capabilities.ts'
import { InvokeSchema, PROTOCOL_VERSION } from './node-protocol.ts'
import { NodeSchema } from './nodes.ts'

const v1 = {
  name: 'laptop-e',
  os: 'darwin',
  arch: 'arm64',
  version: '0.1.0',
  capabilities: ['system.info', 'shell.exec'],
  policy: { allowShell: false },
}

const driver = (name: string, capabilities: { id: string; schemaVersion: number }[]) => ({
  name,
  version: '0.1.0',
  capabilities,
})

const v2 = {
  manifestVersion: 2,
  name: 'laptop-e',
  os: 'darwin',
  arch: 'arm64',
  version: '0.3.0',
  policy: { allowShell: true },
  drivers: [
    driver('system', [{ id: 'system.info', schemaVersion: 1 }]),
    driver('desktop', [
      { id: 'desktop.info', schemaVersion: 1 },
      { id: 'desktop.screenshot', schemaVersion: 1 },
    ]),
  ],
}

/** A spec with a risk function, built per test; the examples decide what a `never` approval may claim. */
function specWith(
  risk: NodeCapabilitySpec['risk'],
  approval: NodeCapabilitySpec['approval'],
  examples?: readonly unknown[],
): NodeCapabilitySpec {
  return {
    id: 'sandbox.run',
    version: 1,
    supports: [1],
    driver: 'sandbox',
    layer: 'self',
    summary: 'test spec',
    risk,
    approval,
    input: z.object({ network: z.boolean().optional() }),
    examples,
  } as NodeCapabilitySpec
}

describe('capability ids', () => {
  test('ids follow <driver>.<action>, at most 64 characters', () => {
    for (const id of ['system.info', 'shell.exec', 'desktop.screenshot', 'sandbox.run', 'a.b-c']) {
      expect(CapabilityIdSchema.safeParse(id).success).toBe(true)
    }
    for (const id of ['notify', 'Bad.Id', 'desktop..x', '1desk.top', 'desktop.', 'x'.repeat(70)]) {
      expect(CapabilityIdSchema.safeParse(id).success).toBe(false)
    }
    expect(CapabilityIdSchema.safeParse(`a.${'b'.repeat(63)}`).success).toBe(false)
  })

  test('the driver of an id is its first segment', () => {
    expect(driverOf('desktop.input')).toBe('desktop')
    expect(driverOf('notify')).toBe('notify')
  })
})

describe('manifests', () => {
  test('a v1 manifest parses (protocol 1 and 2 nodes)', () => {
    expect(NodeManifestSchema.safeParse(v1).success).toBe(true)
    expect(NodeManifestSchema.safeParse({ ...v1, manifestVersion: 1 }).success).toBe(true)
  })

  test('a v2 manifest parses with drivers, schema versions and options', () => {
    const withOptions = {
      ...v2,
      drivers: [
        {
          ...v2.drivers[1],
          options: { allowInput: false, maxActionsPerMinute: 60, network: null },
        },
      ],
    }
    expect(NodeManifestSchema.safeParse(v2).success).toBe(true)
    expect(NodeManifestSchema.safeParse(withOptions).success).toBe(true)
  })

  test('17 drivers fail the v2 manifest', () => {
    const drivers = Array.from({ length: 17 }, (_, i) =>
      driver(`d${String.fromCharCode(97 + i)}`, [
        { id: `d${String.fromCharCode(97 + i)}.x`, schemaVersion: 1 },
      ]),
    )
    expect(NodeManifestSchema.safeParse({ ...v2, drivers: drivers.slice(0, 16) }).success).toBe(
      true,
    )
    expect(NodeManifestSchema.safeParse({ ...v2, drivers }).success).toBe(false)
  })

  test('more than 64 capabilities in total fail the v2 manifest', () => {
    const caps = Array.from({ length: 65 }, (_, i) => ({
      id: `desktop.a${i}`,
      schemaVersion: 1,
    }))
    const oneDriver = { ...v2, drivers: [driver('desktop', caps)] }
    expect(NodeManifestSchema.safeParse(oneDriver).success).toBe(false)
    const split = {
      ...v2,
      drivers: [driver('desktop', caps.slice(0, 32)), driver('desktop', caps.slice(32, 64))],
    }
    expect(NodeManifestSchema.safeParse(split).success).toBe(true)
  })

  test('a bad id or a bad schema version fails the manifest', () => {
    const badId = {
      ...v2,
      drivers: [driver('desktop', [{ id: 'Desktop.Shot', schemaVersion: 1 }])],
    }
    expect(NodeManifestSchema.safeParse(badId).success).toBe(false)
    const badVersion = {
      ...v2,
      drivers: [driver('desktop', [{ id: 'desktop.info', schemaVersion: 0 }])],
    }
    expect(NodeManifestSchema.safeParse(badVersion).success).toBe(false)
    expect(NodeManifestSchema.safeParse({ ...v1, capabilities: ['notify'] }).success).toBe(false)
  })

  test('an unknown manifest version fails both shapes', () => {
    expect(NodeManifestSchema.safeParse({ ...v2, manifestVersion: 3 }).success).toBe(false)
  })

  test('options hold public facts only: bounded keys and short values', () => {
    const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i]))
    const d = { ...v2.drivers[1], options: tooMany }
    expect(NodeManifestSchema.safeParse({ ...v2, drivers: [d] }).success).toBe(false)
    const long = { ...v2.drivers[1], options: { path: 'x'.repeat(300) } }
    expect(NodeManifestSchema.safeParse({ ...v2, drivers: [long] }).success).toBe(false)
  })
})

describe('node rows and invoke', () => {
  const node = {
    id: 'n',
    name: 'laptop-e',
    os: 'darwin',
    arch: 'arm64',
    version: '0.3.0',
    capabilities: ['system.info', 'desktop.screenshot'],
    allowShell: false,
    status: 'online',
    lastSeenAt: null,
    createdAt: 1,
  }

  test('a node row carries drivers and refusals; both default to empty for old rows', () => {
    const full = {
      ...node,
      drivers: [{ name: 'desktop', version: '0.1.0' }],
      refused: [{ id: 'iot.switch', schemaVersion: 1, reason: 'unknown-capability' }],
    }
    expect(NodeSchema.parse(full)).toMatchObject({ drivers: full.drivers, refused: full.refused })
    expect(NodeSchema.parse(node)).toMatchObject({ drivers: [], refused: [] })
    const badReason = { ...node, refused: [{ id: 'x.y', schemaVersion: 1, reason: 'nope' }] }
    expect(NodeSchema.safeParse(badReason).success).toBe(false)
  })

  test('invoke takes an optional capabilityVersion, and protocol 3 is what this build speaks', () => {
    const base = { v: PROTOCOL_VERSION, type: 'invoke', callId: 'c', capability: 'desktop.info' }
    const withVersion = { ...base, capabilityVersion: 1, input: {}, timeoutMs: 5000 }
    expect(InvokeSchema.safeParse(withVersion).success).toBe(true)
    expect(InvokeSchema.safeParse({ ...base, input: {}, timeoutMs: 5000 }).success).toBe(true)
    expect(InvokeSchema.safeParse({ ...withVersion, capabilityVersion: 0 }).success).toBe(false)
    expect(PROTOCOL_VERSION).toBe(3)
  })
})

describe('built-in capabilities', () => {
  test('CAPABILITIES keeps the built-in risks, drivers and schemas', () => {
    expect(CAPABILITIES['system.info']).toMatchObject({ risk: 'read', driver: 'system' })
    expect(CAPABILITIES['shell.exec']).toMatchObject({ risk: 'destructive', driver: 'shell' })
    expect(CAPABILITIES['desktop.info']).toMatchObject({ risk: 'read', driver: 'desktop' })
    expect(CAPABILITIES['desktop.screenshot']).toMatchObject({
      risk: 'external',
      approval: 'by-risk',
      driver: 'desktop',
    })
    expect(CAPABILITIES['desktop.input']).toMatchObject({
      risk: 'destructive',
      approval: 'by-risk',
      driver: 'desktop',
    })
    expect(capabilityRisk('system.info')).toBe('read')
    expect(capabilityRisk('shell.exec')).toBe('destructive')
    expect(capabilityRisk('shell.exec', { command: 'ls' })).toBe('destructive')
    expect(capabilityRisk('desktop.screenshot')).toBe('external')
    expect(capabilityRisk('desktop.input', { actions: [{ type: 'click', x: 1, y: 2 }] })).toBe(
      'destructive',
    )
    expect(capabilityRisk('toString')).toBeUndefined()
  })

  test('desktop schemas: screenshot defaults maxWidth to 1280; input takes 1 to 10 actions', () => {
    const shot = CAPABILITIES['desktop.screenshot'].input
    expect(shot.parse({})).toEqual({ maxWidth: 1280 })
    expect(shot.safeParse({ maxWidth: 99 }).success).toBe(false)
    const input = CAPABILITIES['desktop.input'].input
    const click = { type: 'click', x: 412, y: 230 }
    expect(input.safeParse({ actions: [click] }).success).toBe(true)
    expect(input.safeParse({ actions: [] }).success).toBe(false)
    expect(input.safeParse({ actions: Array(11).fill(click) }).success).toBe(false)
    expect(input.safeParse({ actions: [{ type: 'click', x: -1, y: 2 }] }).success).toBe(false)
    expect(input.safeParse({ actions: [{ type: 'hover' }] }).success).toBe(false)
    expect(
      input.safeParse({ actions: [{ type: 'drag', x: 1, y: 2, to: { x: 3, y: 4 } }] }).success,
    ).toBe(true)
  })
})

describe('sandbox.run', () => {
  const spec = CAPABILITIES['sandbox.run']
  const run = (input: Record<string, unknown>) => spec.input.safeParse(input)

  test('the spec is driver sandbox, never approved above write, and its risk follows network', () => {
    expect(spec).toMatchObject({
      driver: 'sandbox',
      approval: 'never',
      layer: 'self',
      version: 2,
      supports: [1, 2],
    })
    expect(capabilityRisk('sandbox.run', { language: 'python', code: 'print(1)' })).toBe('write')
    expect(
      capabilityRisk('sandbox.run', { language: 'python', code: 'print(1)', network: false }),
    ).toBe('write')
    expect(
      capabilityRisk('sandbox.run', { language: 'python', code: 'print(1)', network: true }),
    ).toBe('external')
  })

  test('language is one of sh, python, node, bun', () => {
    expect(run({ language: 'python', code: 'x' }).success).toBe(true)
    expect(run({ language: 'ruby', code: 'x' }).success).toBe(false)
  })

  test('code of exactly 100 000 bytes is valid, 100 001 bytes is invalid', () => {
    expect(run({ language: 'sh', code: 'a'.repeat(100_000) }).success).toBe(true)
    expect(run({ language: 'sh', code: 'a'.repeat(100_001) }).success).toBe(false)
  })

  test('the limit counts UTF-8 bytes, not characters', () => {
    // 50 000 two-byte characters are 100 000 bytes: valid; one more byte-heavy character is not
    expect(run({ language: 'sh', code: 'é'.repeat(50_000) }).success).toBe(true)
    expect(run({ language: 'sh', code: 'é'.repeat(50_001) }).success).toBe(false)
  })

  test('empty code, timeouts above 120 000 ms and a non-boolean network are invalid', () => {
    expect(run({ language: 'sh', code: '' }).success).toBe(false)
    expect(run({ language: 'sh', code: 'x', timeoutMs: 120_000 }).success).toBe(true)
    expect(run({ language: 'sh', code: 'x', timeoutMs: 120_001 }).success).toBe(false)
    expect(run({ language: 'sh', code: 'x', network: 'yes' }).success).toBe(false)
  })

  test('the output holds stdout, stderr, exitCode, timedOut and truncated', () => {
    const out = CAPABILITIES['sandbox.run'].output
    expect(
      out?.safeParse({ stdout: 'a', stderr: '', exitCode: 0, timedOut: false, truncated: false })
        .success,
    ).toBe(true)
    expect(out?.safeParse({ stdout: 'a', exitCode: 0 }).success).toBe(false)
  })
})

describe('defineNodeCapability', () => {
  test('a valid spec with approval by-risk is returned frozen', () => {
    const s = defineNodeCapability(specWith('write', 'by-risk'))
    expect(Object.isFrozen(s)).toBe(true)
  })

  test('approval never is accepted for a risk at or below write', () => {
    expect(() => defineNodeCapability(specWith('write', 'never'))).not.toThrow()
    expect(() => defineNodeCapability(specWith('read', 'never'))).not.toThrow()
    const fn = (i: { network?: boolean }) => (i.network ? 'external' : 'write')
    expect(() =>
      defineNodeCapability(specWith(fn as never, 'never', [{}, { network: false }])),
    ).not.toThrow()
  })

  test('approval never with a risk that is never write or below is rejected', () => {
    const fn = (i: { network?: boolean }) => (i.network ? 'external' : 'write')
    const alwaysExternal = (_i: { network?: boolean }) => 'external' as const
    expect(() =>
      defineNodeCapability(specWith(alwaysExternal as never, 'never', [{}, { network: true }])),
    ).toThrow(/write or below/)
    expect(() => defineNodeCapability(specWith(fn as never, 'never', [{ network: true }]))).toThrow(
      /write or below/,
    )
    expect(() => defineNodeCapability(specWith('destructive', 'never'))).toThrow(/destructive/)
  })

  test('approval never with a risk that is write for some input and external for others is accepted', () => {
    // the external input is not run unasked: the call asks the owner by its risk (node-drivers.md)
    const fn = (i: { network?: boolean }) => (i.network ? 'external' : 'write')
    const spec = defineNodeCapability(specWith(fn as never, 'never', [{ network: true }, {}]))
    expect(spec.approval).toBe('never')
  })

  test('approval never with a risk function needs examples to check', () => {
    const fn = () => 'write' as const
    expect(() => defineNodeCapability(specWith(fn, 'never'))).toThrow(/examples/)
  })

  test('a bad id, a driver that is not the first segment, or bad versions are rejected', () => {
    expect(() => defineNodeCapability({ ...specWith('read', 'by-risk'), id: 'Bad' })).toThrow()
    expect(() => defineNodeCapability({ ...specWith('read', 'by-risk'), driver: 'desk' })).toThrow()
    expect(() => defineNodeCapability({ ...specWith('read', 'by-risk'), version: 2 })).toThrow()
    expect(() => defineNodeCapability({ ...specWith('read', 'by-risk'), supports: [] })).toThrow()
  })
})

describe('sandbox.run schema v2: files', () => {
  const v2 = CAPABILITIES['sandbox.run'].input
  const base = { language: 'python', code: 'print(1)' }
  const wire = SandboxRunWireSchema
  const small = Buffer.from('hello').toString('base64')
  const megabyte = Buffer.alloc(1_000_000, 1).toString('base64')
  const over = Buffer.alloc(1_000_001, 1).toString('base64')

  test('v1 input (no files) still parses at v2', () => {
    expect(v2.safeParse(base).success).toBe(true)
  })

  test('files name a ref and a container name; output names are plain names', () => {
    expect(
      v2.safeParse({
        ...base,
        files: [{ ref: 'people/A/data.csv', name: 'data.csv' }],
        outputFiles: ['out.txt'],
      }).success,
    ).toBe(true)
    for (const name of ['../x', 'a/b', '.hidden', '', 'x'.repeat(129)]) {
      expect(v2.safeParse({ ...base, files: [{ ref: 'a', name }] }).success).toBe(false)
      expect(v2.safeParse({ ...base, outputFiles: [name] }).success).toBe(false)
    }
  })

  test('at most 5 files, each name used once, each ref at most 512 characters', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ ref: `people/A/f${i}`, name: `f${i}` }))
    expect(v2.safeParse({ ...base, files: six }).success).toBe(false)
    expect(v2.safeParse({ ...base, files: six.slice(0, 5) }).success).toBe(true)
    expect(v2.safeParse({ ...base, files: [six[0], { ref: 'x', name: 'f0' }] }).success).toBe(false)
    expect(v2.safeParse({ ...base, outputFiles: ['a', 'a'] }).success).toBe(false)
    expect(v2.safeParse({ ...base, files: [{ ref: 'r'.repeat(513), name: 'a' }] }).success).toBe(
      false,
    )
  })

  test('the wire form carries base64 bytes, at most 1 MB decoded', () => {
    const file = (data: string) => ({ name: 'in.bin', data })
    expect(wire.safeParse({ ...base, files: [file(small)] }).success).toBe(true)
    expect(wire.safeParse({ ...base, files: [file(megabyte)] }).success).toBe(true)
    expect(wire.safeParse({ ...base, files: [file(over)] }).success).toBe(false)
    expect(wire.safeParse({ ...base, files: [file('not base64!')] }).success).toBe(false)
  })

  test('base64ByteLength counts the decoded bytes', () => {
    expect(base64ByteLength(small)).toBe(5)
    expect(base64ByteLength(Buffer.alloc(0).toString('base64'))).toBe(0)
    expect(base64ByteLength(Buffer.alloc(1, 2).toString('base64'))).toBe(1)
  })

  test('the v2 output may carry files and what is missing; v1 output is unchanged', () => {
    const out = SandboxRunOutputV2Schema
    const v1 = { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false }
    expect(out.safeParse(v1).success).toBe(true)
    expect(
      out.safeParse({ ...v1, files: [{ name: 'o.txt', data: small }], missing: ['x.txt'] }).success,
    ).toBe(true)
  })
})
