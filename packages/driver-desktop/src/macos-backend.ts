// The macOS backend (docs/specs/node-drivers.md, "Driver desktop"). Images come from `screencapture`
// (resized with `sips`), mouse events from osascript's JavaScript bridge to CoreGraphics, keys and text
// from System Events. Every program starts from an argument array. User text reaches a script only as
// one JSON argument, never inside the script source.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopAction } from './actions.ts'
import {
  type DesktopBackend,
  type DesktopInfo,
  type DisplayInfo,
  MissingPermissionError,
  type PermissionState,
} from './backend.ts'
import { jpegSize } from './jpeg.ts'

export interface ProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Starts one program and waits for it; the signal kills it. Tests replace it with a fake. */
export type ProcessRunner = (argv: readonly string[], signal: AbortSignal) => Promise<ProcessResult>

/** The programs get a fixed, minimal environment: nothing from the node's own environment. */
const CHILD_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' }

export const runProcess: ProcessRunner = async (argv, signal) => {
  const proc = Bun.spawn([...argv], { stdout: 'pipe', stderr: 'pipe', env: CHILD_ENV })
  const stop = () => proc.kill()
  signal.addEventListener('abort', stop, { once: true })
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode, stdout, stderr }
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

// Scripts are constants. They read their input from argv (JSON) and never from interpolated text.
const PERMISSIONS_JS = [
  "ObjC.import('ApplicationServices');",
  "ObjC.import('CoreGraphics');",
  'function run() {',
  '  return JSON.stringify({',
  '    screenRecording: $.CGPreflightScreenCaptureAccess(),',
  '    accessibility: $.AXIsProcessTrusted(),',
  '  });',
  '}',
].join('\n')

const INFO_JS = [
  "ObjC.import('AppKit');",
  'function run() {',
  '  var screens = $.NSScreen.screens;',
  '  var displays = [];',
  '  for (var i = 0; i < screens.count; i++) {',
  '    var screen = screens.objectAtIndex(i);',
  '    displays.push({',
  '      id: i,',
  '      width: screen.frame.size.width,',
  '      height: screen.frame.size.height,',
  '      scale: screen.backingScaleFactor,',
  '    });',
  '  }',
  '  var result = { displays: displays };',
  '  try {',
  "    result.frontApp = Application('System Events').processes.whose({ frontmost: true })[0].name();",
  '  } catch (error) {',
  '    // No Accessibility permission or no frontmost app: the field is left out.',
  '  }',
  '  return JSON.stringify(result);',
  '}',
].join('\n')

// Event types: 1 left down, 2 left up, 3 right down, 4 right up, 5 moved, 6 left dragged.
// Click state field 1 is kCGMouseEventClickState; a double click sends state 1 then 2.
const INPUT_JS = [
  "ObjC.import('CoreGraphics');",
  "var MODIFIERS = { cmd: 'command down', shift: 'shift down', alt: 'option down', ctrl: 'control down' };",
  "var KEY_CODES = { 'return': 36, tab: 48, space: 49, 'delete': 51, escape: 53, left: 123, right: 124, down: 125, up: 126 };",
  'function mouse(type, x, y, button, clickState) {',
  '  var event = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), button);',
  '  if (clickState) { $.CGEventSetIntegerValueField(event, 1, clickState); }',
  '  $.CGEventPost(0, event);',
  '}',
  'function press(x, y, right, clickState) {',
  '  mouse(right ? 3 : 1, x, y, right ? 1 : 0, clickState);',
  '  mouse(right ? 4 : 2, x, y, right ? 1 : 0, clickState);',
  '}',
  'function run(argv) {',
  '  var actions = JSON.parse(argv[0]);',
  "  var system = Application('System Events');",
  '  actions.forEach(function (a) {',
  "    if (a.type === 'move') { mouse(5, a.x, a.y, 0, 0); }",
  "    else if (a.type === 'click') { press(a.x, a.y, false, 1); }",
  "    else if (a.type === 'double_click') { press(a.x, a.y, false, 1); press(a.x, a.y, false, 2); }",
  "    else if (a.type === 'right_click') { press(a.x, a.y, true, 1); }",
  "    else if (a.type === 'drag') {",
  '      mouse(1, a.x, a.y, 0, 1);',
  '      mouse(6, a.to.x, a.to.y, 0, 1);',
  '      mouse(2, a.to.x, a.to.y, 0, 1);',
  '    }',
  "    else if (a.type === 'scroll') {",
  '      var wheel = { up: [3, 0], down: [-3, 0], left: [0, 3], right: [0, -3] }[(a.keys || ["down"])[0]];',
  '      var event = $.CGEventCreateScrollWheelEvent2(null, 1, 2, wheel[0], wheel[1], 0);',
  '      $.CGEventSetLocation(event, $.CGPointMake(a.x, a.y));',
  '      $.CGEventPost(0, event);',
  '    }',
  "    else if (a.type === 'type') { system.keystroke(a.text); }",
  "    else if (a.type === 'key') {",
  '      var keys = a.keys;',
  '      var key = keys[keys.length - 1];',
  '      var using = keys.slice(0, -1).map(function (m) { return MODIFIERS[m]; });',
  '      var options = using.length > 0 ? { using: using } : {};',
  '      if (KEY_CODES.hasOwnProperty(key)) { system.keyCode(KEY_CODES[key], options); }',
  '      else { system.keystroke(key, options); }',
  '    }',
  '    delay(0.02);',
  '  });',
  "  return 'ok';",
  '}',
].join('\n')

const SCREEN_RECORDING = 'Screen Recording'
const ACCESSIBILITY = 'Accessibility'

/** Maps an osascript failure to the missing permission it names, or a plain error. */
function osascriptError(stderr: string, exitCode: number): Error {
  if (/\(1002\)|\(1719\)|assistive access|not allowed to send keystrokes/i.test(stderr)) {
    return new MissingPermissionError(ACCESSIBILITY)
  }
  return new Error(`osascript failed (exit ${exitCode}): ${stderr.trim() || 'no output'}`)
}

export function createMacosBackend(
  run: ProcessRunner = runProcess,
  scratch: string = tmpdir(),
): DesktopBackend {
  async function osascript(
    script: string,
    args: readonly string[],
    signal: AbortSignal,
  ): Promise<string> {
    const result = await run(['osascript', '-l', 'JavaScript', '-e', script, ...args], signal)
    if (result.exitCode !== 0) throw osascriptError(result.stderr, result.exitCode)
    return result.stdout.trim()
  }

  async function info(signal: AbortSignal): Promise<DesktopInfo> {
    const parsed = JSON.parse(await osascript(INFO_JS, [], signal)) as {
      displays?: DisplayInfo[]
      frontApp?: string
    }
    if (!Array.isArray(parsed.displays)) throw new Error('desktop info has no display list')
    return parsed.frontApp === undefined
      ? { displays: parsed.displays }
      : { displays: parsed.displays, frontApp: parsed.frontApp }
  }

  return {
    async permissions(signal: AbortSignal): Promise<PermissionState> {
      return JSON.parse(await osascript(PERMISSIONS_JS, [], signal)) as PermissionState
    },

    info,

    async screenshot({ display, maxWidth, signal }) {
      const displays = (await info(signal)).displays
      const target = displays.find((candidate) => candidate.id === (display ?? 0))
      if (target === undefined) throw new Error(`no display ${display ?? 0} on this node`)
      const folder = await mkdtemp(join(scratch, 'keith-desktop-'))
      try {
        const file = join(folder, 'screen.jpg')
        // screencapture numbers displays from 1; the driver's ids start at 0.
        const shot = await run(
          ['screencapture', '-x', '-t', 'jpg', '-D', String(target.id + 1), file],
          signal,
        )
        if (shot.exitCode !== 0 || !(await Bun.file(file).exists())) {
          if (/could not create image|not authorized|permission/i.test(shot.stderr)) {
            throw new MissingPermissionError(SCREEN_RECORDING)
          }
          throw new Error(`screencapture failed (exit ${shot.exitCode}): ${shot.stderr.trim()}`)
        }
        let jpeg = await Bun.file(file).bytes()
        const size = jpegSize(jpeg)
        if (size !== undefined && size.width > maxWidth) {
          const resized = await run(['sips', '--resampleWidth', String(maxWidth), file], signal)
          if (resized.exitCode !== 0) throw new Error(`sips failed: ${resized.stderr.trim()}`)
          jpeg = await Bun.file(file).bytes()
        }
        return { display: target, jpeg }
      } finally {
        await rm(folder, { recursive: true, force: true })
      }
    },

    async input(actions: readonly DesktopAction[], signal: AbortSignal) {
      if (actions.length === 0) return
      await osascript(INPUT_JS, [JSON.stringify(actions)], signal)
    },
  }
}
