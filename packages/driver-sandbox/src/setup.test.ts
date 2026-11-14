import { describe, expect, test } from 'bun:test'
import { chooseRuntime, INSTALL_HINT } from './runtime.ts'
import { resolveSandboxSetup } from './setup.ts'

const none = () => undefined
const docker = (name: string) => (name === 'docker' ? '/usr/bin/docker' : undefined)

describe('chooseRuntime', () => {
  test('prefers docker, then podman, and names the install hint when neither is there', () => {
    expect(chooseRuntime(undefined, () => '/x')).toEqual({ ok: true, value: 'docker' })
    expect(chooseRuntime(undefined, (n) => (n === 'podman' ? '/p' : undefined))).toEqual({
      ok: true,
      value: 'podman',
    })
    const missing = chooseRuntime(undefined, none)
    expect(missing).toMatchObject({ ok: false })
    expect(missing.ok === false && missing.message).toContain(INSTALL_HINT)
  })
})

describe('resolveSandboxSetup', () => {
  test('records the runtime and the four images, and the pulls are the distinct images', () => {
    const setup = resolveSandboxSetup({}, docker)
    expect(setup.ok).toBe(true)
    if (!setup.ok) return
    expect(setup.value.options).toEqual({
      runtime: 'docker',
      'image.sh': 'alpine:3.20',
      'image.python': 'python:3.12-alpine',
      'image.node': 'node:22-alpine',
      'image.bun': 'oven/bun:1.2-alpine',
    })
    expect(setup.value.pulls).toEqual([
      'alpine:3.20',
      'python:3.12-alpine',
      'node:22-alpine',
      'oven/bun:1.2-alpine',
    ])
  })

  test('network and an image flag are recorded; no runtime is a refusal with the install hint', () => {
    const setup = resolveSandboxSetup({ network: true, 'image.node': 'node:24-alpine' }, docker)
    expect(setup.ok && setup.value.options).toMatchObject({
      network: true,
      'image.node': 'node:24-alpine',
    })
    const refused = resolveSandboxSetup({}, none)
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.message).toContain('no container runtime found')
  })
})
