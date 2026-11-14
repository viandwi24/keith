import { describe, expect, test } from 'bun:test'
import { type NodeCapabilitySpec, type NodeManifest, NodeManifestSchema } from '@keith/contracts'
import { z } from 'zod'
import {
  acceptStored,
  BUILTIN_CAPABILITY_SPECS,
  createNodeCapabilityRegistry,
} from './node-capabilities.ts'

const identity = {
  name: 'laptop-e',
  os: 'darwin',
  arch: 'arm64',
  version: '0.3.0',
  policy: { allowShell: true },
}

const v1: NodeManifest = {
  ...identity,
  capabilities: ['system.info', 'shell.exec'],
}

/** A test spec for an id a later phase adds (desktop, sandbox): read-only, no approval needed. */
const screenshot: NodeCapabilitySpec = {
  id: 'desktop.screenshot',
  version: 1,
  supports: [1],
  driver: 'desktop',
  layer: 'self',
  summary: 'test spec',
  risk: 'external',
  approval: 'by-risk',
  input: z.object({}),
}

const driver = (name: string, capabilities: { id: string; schemaVersion: number }[]) => ({
  name,
  version: '0.1.0',
  capabilities,
})

describe('built-in specs', () => {
  test('the registry starts with the built-in drivers: system, shell, desktop and sandbox', () => {
    const registry = createNodeCapabilityRegistry()
    expect(BUILTIN_CAPABILITY_SPECS.map((s) => s.id).sort()).toEqual([
      'desktop.info',
      'desktop.input',
      'desktop.screenshot',
      'sandbox.run',
      'shell.exec',
      'system.info',
    ])
    expect(registry.get('sandbox.run')).toMatchObject({
      driver: 'sandbox',
      risk: expect.any(Function),
      approval: 'never',
    })
    expect(registry.get('system.info')).toMatchObject({ driver: 'system', risk: 'read' })
    expect(registry.get('shell.exec')).toMatchObject({ driver: 'shell', risk: 'destructive' })
    expect(registry.get('desktop.screenshot')).toMatchObject({
      driver: 'desktop',
      risk: 'external',
    })
  })
})

describe('accept: refusal reasons', () => {
  test('an unknown id is refused unknown-capability and the rest of the node is accepted', () => {
    const registry = createNodeCapabilityRegistry()
    const result = registry.accept({
      ...identity,
      manifestVersion: 2,
      drivers: [
        driver('system', [{ id: 'system.info', schemaVersion: 1 }]),
        driver('iot', [{ id: 'iot.switch', schemaVersion: 1 }]),
      ],
    })
    expect(result.accepted.map((a) => a.id)).toEqual(['system.info'])
    expect(result.refused).toEqual([
      { id: 'iot.switch', schemaVersion: 1, reason: 'unknown-capability' },
    ])
  })

  test('a schema version the core does not support is refused unsupported-schema', () => {
    const registry = createNodeCapabilityRegistry()
    const result = registry.accept({
      ...identity,
      manifestVersion: 2,
      drivers: [driver('system', [{ id: 'system.info', schemaVersion: 9 }])],
    })
    expect(result.accepted).toEqual([])
    expect(result.refused).toEqual([
      { id: 'system.info', schemaVersion: 9, reason: 'unsupported-schema' },
    ])
  })

  test('a capability under another driver name is refused driver-mismatch', () => {
    const registry = createNodeCapabilityRegistry([screenshot])
    const result = registry.accept({
      ...identity,
      manifestVersion: 2,
      drivers: [driver('shell', [{ id: 'desktop.screenshot', schemaVersion: 1 }])],
    })
    expect(result.refused).toEqual([
      { id: 'desktop.screenshot', schemaVersion: 1, reason: 'driver-mismatch' },
    ])
    const right = registry.accept({
      ...identity,
      manifestVersion: 2,
      drivers: [driver('desktop', [{ id: 'desktop.screenshot', schemaVersion: 1 }])],
    })
    expect(right.accepted).toEqual([
      { id: 'desktop.screenshot', schemaVersion: 1, driver: 'desktop' },
    ])
  })

  test('a client capability announced by a node is refused wrong-layer', () => {
    const registry = createNodeCapabilityRegistry()
    const result = registry.accept({
      ...identity,
      manifestVersion: 2,
      drivers: [
        driver('open', [{ id: 'open.view', schemaVersion: 1 }]),
        driver('location', [{ id: 'location.share', schemaVersion: 1 }]),
      ],
    })
    expect(result.accepted).toEqual([])
    expect(result.refused.map((r) => [r.id, r.reason])).toEqual([
      ['open.view', 'wrong-layer'],
      ['location.share', 'wrong-layer'],
    ])
  })

  test('notify has no dot: the manifest fails the id regex, so the whole manifest is rejected', () => {
    expect(NodeManifestSchema.safeParse({ ...v1, capabilities: ['notify'] }).success).toBe(false)
    expect(
      NodeManifestSchema.safeParse({
        ...identity,
        manifestVersion: 2,
        drivers: [driver('notify', [{ id: 'notify', schemaVersion: 1 }])],
      }).success,
    ).toBe(false)
  })
})

describe('accept: manifests', () => {
  test('a v1 manifest maps to the drivers system and shell at version 1.0.0', () => {
    const result = createNodeCapabilityRegistry().accept(v1)
    expect(result.drivers).toEqual([
      { name: 'system', version: '1.0.0' },
      { name: 'shell', version: '1.0.0' },
    ])
    expect(result.accepted).toEqual([
      { id: 'system.info', schemaVersion: 1, driver: 'system' },
      { id: 'shell.exec', schemaVersion: 1, driver: 'shell' },
    ])
    expect(result.refused).toEqual([])
  })

  test('a v2 manifest reports its drivers as announced', () => {
    const result = createNodeCapabilityRegistry().accept({
      ...identity,
      manifestVersion: 2,
      drivers: [
        driver('system', [{ id: 'system.info', schemaVersion: 1 }]),
        driver('desktop', [{ id: 'desktop.screenshot', schemaVersion: 1 }]),
      ],
    })
    expect(result.drivers).toEqual([
      { name: 'system', version: '0.1.0' },
      { name: 'desktop', version: '0.1.0' },
    ])
    expect(result.accepted.map((a) => a.id)).toEqual(['system.info', 'desktop.screenshot'])
  })

  test('an id announced twice keeps its first entry', () => {
    const result = createNodeCapabilityRegistry().accept({
      ...identity,
      manifestVersion: 2,
      drivers: [
        driver('system', [{ id: 'system.info', schemaVersion: 1 }]),
        driver('system', [{ id: 'system.info', schemaVersion: 1 }]),
      ],
    })
    expect(result.accepted).toHaveLength(1)
  })

  test('a stored manifest that does not parse accepts nothing', () => {
    const registry = createNodeCapabilityRegistry()
    expect(acceptStored(registry, null)).toEqual({ drivers: [], accepted: [], refused: [] })
    expect(acceptStored(registry, { capabilities: 'nope' }).accepted).toEqual([])
    expect(acceptStored(registry, v1).accepted).toHaveLength(2)
  })
})

describe('register', () => {
  test('a spec is added at boot; a duplicate id throws', () => {
    const registry = createNodeCapabilityRegistry([])
    registry.register(screenshot)
    expect(registry.get('desktop.screenshot')).toMatchObject({ driver: 'desktop' })
    expect(() => registry.register(screenshot)).toThrow(/already registered/)
  })

  test('registering after the freeze throws', () => {
    const registry = createNodeCapabilityRegistry([])
    registry.freeze()
    expect(() => registry.register(screenshot)).toThrow(/frozen/)
    expect(registry.get('desktop.screenshot')).toBeUndefined()
    expect(registry.accept(v1).accepted).toHaveLength(0)
  })

  test('a client capability id cannot be registered as a node capability', () => {
    const registry = createNodeCapabilityRegistry([])
    expect(() => registry.register({ ...screenshot, id: 'open.view', driver: 'open' })).toThrow(
      /parietal/,
    )
  })

  test('an invalid spec is rejected by the contract definition', () => {
    const registry = createNodeCapabilityRegistry([])
    expect(() => registry.register({ ...screenshot, supports: [2] })).toThrow()
  })
})
