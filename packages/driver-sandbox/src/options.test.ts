import { describe, expect, test } from 'bun:test'
import { DEFAULT_IMAGES } from './images.ts'
import { parseRunInput, parseSandboxOptions } from './options.ts'

const MAX_CODE_BYTES = 100_000

describe('parseSandboxOptions', () => {
  test('defaults: network off, two at once, the pinned images', () => {
    const parsed = parseSandboxOptions({})
    expect(parsed).toEqual({
      ok: true,
      value: { network: false, maxConcurrent: 2, images: DEFAULT_IMAGES },
    })
  })

  test('an image option replaces one language; a bad reference is refused', () => {
    const ok = parseSandboxOptions({ 'image.python': 'python:3.13-alpine' })
    expect(ok.ok && ok.value.images.python).toBe('python:3.13-alpine')
    expect(parseSandboxOptions({ 'image.python': 'Has Spaces' }).ok).toBe(false)
  })

  test('runtime, network and maxConcurrent are checked', () => {
    expect(parseSandboxOptions({ runtime: 'lxc' }).ok).toBe(false)
    expect(parseSandboxOptions({ network: 'yes' }).ok).toBe(false)
    expect(parseSandboxOptions({ maxConcurrent: 0 }).ok).toBe(false)
    expect(parseSandboxOptions({ maxConcurrent: 9 }).ok).toBe(false)
    expect(parseSandboxOptions({ runtime: 'podman' })).toMatchObject({
      ok: true,
      value: { runtime: 'podman' },
    })
  })
})

describe('parseRunInput', () => {
  const good = { language: 'python', code: 'print(1)' }

  test('a minimal call gets the defaults', () => {
    expect(parseRunInput(good)).toEqual({
      ok: true,
      value: {
        language: 'python',
        code: 'print(1)',
        timeoutMs: 30_000,
        network: false,
        files: [],
        outputFiles: [],
      },
    })
  })

  test('the code limit counts bytes, not characters', () => {
    const multibyte = '€'.repeat(Math.floor(MAX_CODE_BYTES / 3) + 1)
    expect(parseRunInput({ ...good, code: multibyte }).ok).toBe(false)
    expect(parseRunInput({ ...good, code: 'é'.repeat(MAX_CODE_BYTES / 2) }).ok).toBe(true)
  })

  test('language, code and timeout are checked', () => {
    expect(parseRunInput({ ...good, language: 'ruby' }).ok).toBe(false)
    expect(parseRunInput({ ...good, code: '' }).ok).toBe(false)
    expect(parseRunInput({ ...good, timeoutMs: 0 }).ok).toBe(false)
    expect(parseRunInput(null).ok).toBe(false)
  })
})
