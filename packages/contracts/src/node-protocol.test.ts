import { describe, expect, test } from 'bun:test'
import {
  CAPABILITIES,
  CapabilityIdSchema,
  capabilityRisk,
  JoinRequestSchema,
  MIN_PROTOCOL,
  NodeManifestSchema,
  PROTOCOL_VERSION,
  parseCoreMessage,
  parseNodeMessage,
} from './node-protocol.ts'
import { NodeSchema, PairingCodeSchema } from './nodes.ts'

const manifest = {
  name: 'laptop-e',
  os: 'darwin',
  arch: 'arm64',
  version: '0.1.0',
  capabilities: ['system.info', 'shell.exec'],
  policy: { allowShell: false },
}
const v = PROTOCOL_VERSION

describe('capabilities', () => {
  test('risks come from the static table', () => {
    expect(capabilityRisk('system.info')).toBe('read')
    expect(capabilityRisk('shell.exec')).toBe('destructive')
    expect(capabilityRisk('fs.read')).toBeUndefined()
    expect(capabilityRisk('toString')).toBeUndefined()
  })

  test('shell.exec input is bounded', () => {
    const input = CAPABILITIES['shell.exec'].input
    expect(input.safeParse({ command: 'ls', cwd: '/tmp', timeoutMs: 1000 }).success).toBe(true)
    expect(input.safeParse({ command: '' }).success).toBe(false)
    expect(input.safeParse({ command: 'x'.repeat(4001) }).success).toBe(false)
    expect(input.safeParse({ command: 'ls', timeoutMs: 120_001 }).success).toBe(false)
    expect(CAPABILITIES['system.info'].input.safeParse({}).success).toBe(true)
  })

  test('ids outside the grammar are rejected in manifests; a well-formed unknown id is the registry call', () => {
    expect(CapabilityIdSchema.safeParse('fs.read').success).toBe(true)
    expect(CapabilityIdSchema.safeParse('notify').success).toBe(false)
    expect(NodeManifestSchema.safeParse({ ...manifest, capabilities: ['notify'] }).success).toBe(
      false,
    )
    expect(NodeManifestSchema.safeParse(manifest).success).toBe(true)
    expect(NodeManifestSchema.safeParse({ ...manifest, name: 'Bad Name' }).success).toBe(false)
  })
})

describe('node messages', () => {
  test('valid node → core messages parse, as object or JSON string', () => {
    const msgs = [
      { v, type: 'hello', manifest },
      { v, type: 'heartbeat', at: 1 },
      { v, type: 'progress', callId: 'c', chunk: 'hi', stream: 'stdout' },
      { v, type: 'result', callId: 'c', ok: true, output: { a: 1 }, exitCode: 0 },
      { v, type: 'result', callId: 'c', ok: false, error: { code: 'timeout', message: 'slow' } },
    ]
    for (const m of msgs) {
      const r = parseNodeMessage(m)
      expect(r.ok).toBe(true)
      expect(parseNodeMessage(JSON.stringify(m)).ok).toBe(true)
    }
  })

  test('valid core → node messages parse', () => {
    const msgs = [
      { v, type: 'welcome', accepted: true, nodeId: 'n', heartbeatMs: 10_000 },
      { v, type: 'welcome', accepted: false, nodeId: '', heartbeatMs: 10_000, reason: 'old' },
      { v, type: 'invoke', callId: 'c', capability: 'shell.exec', input: {}, timeoutMs: 5000 },
      { v, type: 'cancel', callId: 'c' },
    ]
    for (const m of msgs) expect(parseCoreMessage(m).ok).toBe(true)
  })

  test('direction matters', () => {
    expect(parseCoreMessage({ v, type: 'heartbeat', at: 1 }).ok).toBe(false)
    expect(parseNodeMessage({ v, type: 'cancel', callId: 'c' }).ok).toBe(false)
  })

  test('invalid messages return an error and never throw', () => {
    expect(parseNodeMessage({ v, type: 'heartbeat' }).ok).toBe(false)
    expect(parseNodeMessage({ v, type: 'nope' }).ok).toBe(false)
    expect(parseNodeMessage('{not json').ok).toBe(false)
    expect(parseNodeMessage(null).ok).toBe(false)
    expect(parseCoreMessage(undefined).ok).toBe(false)
    expect(
      parseNodeMessage({
        v,
        type: 'result',
        callId: 'c',
        ok: false,
        error: { code: 'x', message: '' },
      }).ok,
    ).toBe(false)
  })

  test('a version below MIN_PROTOCOL is rejected with an explanation', () => {
    const r = parseNodeMessage({ v: MIN_PROTOCOL - 1, type: 'heartbeat', at: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('protocol version')
    const c = parseCoreMessage({ v: 0, type: 'cancel', callId: 'c' })
    expect(c.ok).toBe(false)
  })
})

describe('join and node rows', () => {
  test('join request accepts codes as typed', () => {
    expect(JoinRequestSchema.safeParse({ code: 'ABCD-EFGH', manifest }).success).toBe(true)
    for (const code of ['abcd-efgh', 'ABCDEFGH', ' abcd efgh ']) {
      expect(JoinRequestSchema.safeParse({ code, manifest }).success).toBe(true)
    }
    expect(JoinRequestSchema.parse({ code: ' abcd efgh ', manifest }).code).toBe('abcd efgh')
    expect(JoinRequestSchema.safeParse({ code: 'abc', manifest }).success).toBe(false)
    expect(JoinRequestSchema.safeParse({ code: 'x'.repeat(17), manifest }).success).toBe(false)
  })

  test('pairing code format and node row', () => {
    const p = { code: 'ABCD-2FGH', expiresAt: 1, joinCommand: 'bun src/main.ts join' }
    expect(PairingCodeSchema.safeParse(p).success).toBe(true)
    expect(PairingCodeSchema.safeParse({ ...p, code: 'ABCDEFGH' }).success).toBe(false)
    const node = {
      id: 'n',
      name: 'laptop-e',
      os: 'darwin',
      arch: 'arm64',
      version: '0.1.0',
      capabilities: ['system.info'],
      allowShell: false,
      status: 'online',
      lastSeenAt: null,
      createdAt: 1,
    }
    expect(NodeSchema.safeParse(node).success).toBe(true)
    expect(NodeSchema.safeParse({ ...node, status: 'gone' }).success).toBe(false)
  })
})

describe('protocol versions (rotation is 2, drivers are 3)', () => {
  test('a busy result is a node error code, and an unknown code is not', () => {
    const busy = {
      v,
      type: 'result',
      callId: 'c',
      ok: false,
      error: { code: 'busy', message: 'x' },
    }
    expect(parseNodeMessage(busy).ok).toBe(true)
    const unknown = { ...busy, error: { code: 'rate-limited', message: 'x' } }
    expect(parseNodeMessage(unknown).ok).toBe(false)
  })

  test('v3 is the protocol, and v1 messages still parse unchanged', () => {
    expect(PROTOCOL_VERSION).toBe(3)
    expect(MIN_PROTOCOL).toBe(1)
    expect(parseNodeMessage({ v: 1, type: 'heartbeat', at: 1 }).ok).toBe(true)
    expect(
      parseCoreMessage({ v: 1, type: 'welcome', accepted: true, nodeId: 'n', heartbeatMs: 1 }).ok,
    ).toBe(true)
    expect(
      parseCoreMessage({
        v: 1,
        type: 'invoke',
        callId: 'c',
        capability: 'system.info',
        input: {},
        timeoutMs: 1,
      }).ok,
    ).toBe(true)
  })

  test('rotate goes from core to node, rotated from node to core, never the other way', () => {
    expect(parseCoreMessage({ v, type: 'rotate', token: 'node-token-example' })).toMatchObject({
      ok: true,
      message: { type: 'rotate', token: 'node-token-example' },
    })
    expect(parseNodeMessage({ v, type: 'rotated' })).toMatchObject({
      ok: true,
      message: { type: 'rotated' },
    })
    expect(parseNodeMessage({ v, type: 'rotate', token: 'node-token-example' }).ok).toBe(false)
    expect(parseCoreMessage({ v, type: 'rotated' }).ok).toBe(false)
  })

  test('an empty rotate token is refused', () => {
    expect(parseCoreMessage({ v, type: 'rotate', token: '' }).ok).toBe(false)
  })
})
