// The macOS backend with a fake process runner: checks the argument arrays only. No program is started
// and no screen or input device is touched.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopAction } from './actions.ts'
import { MissingPermissionError } from './backend.ts'
import { createMacosBackend, type ProcessResult, type ProcessRunner } from './macos-backend.ts'
import { fakeJpeg } from './testing/fake-backend.ts'

let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'keith-desktop-macos-test-'))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

const ok = (stdout = ''): ProcessResult => ({ exitCode: 0, stdout, stderr: '' })
const INFO = JSON.stringify({
  displays: [{ id: 0, width: 1440, height: 900, scale: 2 }],
  frontApp: 'Notes',
})

/** A runner that answers from a script table and records every argument array it was given. */
function recordingRunner(
  answer: (argv: readonly string[]) => Promise<ProcessResult> | ProcessResult,
) {
  const seen: string[][] = []
  const run: ProcessRunner = async (argv) => {
    seen.push([...argv])
    return answer(argv)
  }
  return { run, seen }
}

describe('macOS backend argument arrays', () => {
  test('the screenshot is taken with screencapture for the chosen display, then resized with sips', async () => {
    const { run, seen } = recordingRunner(async (argv) => {
      if (argv[0] === 'osascript') return ok(INFO)
      if (argv[0] === 'screencapture') {
        await Bun.write(argv[argv.length - 1] as string, fakeJpeg(1440, 900, 200))
        return ok()
      }
      if (argv[0] === 'sips') {
        await Bun.write(argv[argv.length - 1] as string, fakeJpeg(1280, 800, 100))
        return ok()
      }
      throw new Error(`unexpected program ${argv[0]}`)
    })
    const backend = createMacosBackend(run, scratch)
    const shot = await backend.screenshot({
      display: 0,
      maxWidth: 1280,
      signal: new AbortController().signal,
    })

    const capture = seen.find((argv) => argv[0] === 'screencapture')
    expect(capture?.slice(0, 6)).toEqual(['screencapture', '-x', '-t', 'jpg', '-D', '1'])
    expect(seen.find((argv) => argv[0] === 'sips')?.slice(1, 4)).toEqual([
      '--resampleWidth',
      '1280',
      capture?.[6] ?? '',
    ])
    expect(shot.display.scale).toBe(2)
    expect(shot.jpeg.byteLength).toBe(100)
  })

  test('a screencapture that cannot create the image names the Screen Recording permission', async () => {
    const { run } = recordingRunner(async (argv) => {
      if (argv[0] === 'osascript') return ok(INFO)
      return { exitCode: 1, stdout: '', stderr: 'could not create image on display 1' }
    })
    const backend = createMacosBackend(run, scratch)
    await expect(
      backend.screenshot({ maxWidth: 1280, signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(MissingPermissionError)
  })

  test('input sends the actions as one JSON argument, never inside the script source', async () => {
    const hostile = `x'; do shell script "rm -rf ~"; '`
    const actions: DesktopAction[] = [
      { type: 'click', x: 10, y: 20 },
      { type: 'type', text: hostile },
    ]
    const { run, seen } = recordingRunner(() => ok())
    const backend = createMacosBackend(run, scratch)
    await backend.input(actions, new AbortController().signal)

    expect(seen).toHaveLength(1)
    const argv = seen[0] ?? []
    expect(argv.slice(0, 4)).toEqual(['osascript', '-l', 'JavaScript', '-e'])
    expect(argv[argv.length - 1]).toBe(JSON.stringify(actions))
    const script = argv[4] ?? ''
    expect(script).not.toContain(hostile)
    expect(script).not.toContain('do shell script')
    expect(argv.slice(0, -1).join('\n')).not.toContain(hostile)
  })

  test('a System Events permission refusal names Accessibility', async () => {
    const { run } = recordingRunner(() => ({
      exitCode: 1,
      stdout: '',
      stderr:
        '31:45: execution error: System Events got an error: osascript is not allowed to send keystrokes. (1002)',
    }))
    const backend = createMacosBackend(run, scratch)
    const failure = await backend
      .input([{ type: 'type', text: 'hi' }], new AbortController().signal)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(MissingPermissionError)
    expect((failure as MissingPermissionError).permission).toBe('Accessibility')
  })

  test('permissions are read with the ApplicationServices bridge in one call', async () => {
    const { run, seen } = recordingRunner(() =>
      ok('{"screenRecording":true,"accessibility":false}'),
    )
    const backend = createMacosBackend(run, scratch)
    expect(await backend.permissions(new AbortController().signal)).toEqual({
      screenRecording: true,
      accessibility: false,
    })
    expect(seen[0]?.[4]).toContain('AXIsProcessTrusted')
  })
})
