import { join } from 'node:path'
import { type Child, stopProc, track, until } from './proc.ts'

const cli = join(import.meta.dir, '../../apps/tui/src/cli.tsx')

/** Ink prints only a final frame in CI: hide every CI marker from the child. */
export function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === 'CI' || k === 'CONTINUOUS_INTEGRATION' || k.startsWith('CI_'))
      continue
    env[k] = v
  }
  return { ...env, ...extra }
}

export interface Tui {
  screen(): string
  send(text: string): void
  /** Type a line, press Enter. */
  say(text: string): Promise<void>
  stop(): Promise<void>
}

export interface TuiOptions {
  /** The command line after the binary (default `chat`). */
  args?: string[]
  /** Text that says the screen is up (default: the chat's input placeholder). */
  ready?: string[]
}

/** The TUI in a real pseudo-terminal (`Bun.spawn({ terminal })` keeps draining the pty). */
export async function startTui(
  env: Record<string, string>,
  options: TuiOptions = {},
): Promise<Tui> {
  // The TUI draws its cursor and placeholder with colour codes ("✳ <inverse>t</inverse>ype a
  // message"), so the raw bytes never hold the text in one piece: match on the stripped text.
  let raw = ''
  const screen = (): string => Bun.stripANSI(raw)
  const proc = Bun.spawn(['bun', cli, ...(options.args ?? ['chat'])], {
    env,
    terminal: {
      cols: 100,
      rows: 30,
      data: (_t, data) => {
        raw += Buffer.from(data)
      },
    },
  })
  track('tui', proc, () => raw)
  const send = (text: string) => proc.terminal?.write(text)
  for (const text of options.ready ?? ['type a message, or /help']) {
    // the once-per-person audit notice (P23 §6) covers the screen at a first sign-in: acknowledge it
    let acked = 0
    await until(
      () => {
        if (screen().includes('[enter] got it') && Date.now() - acked > 1500) {
          send('\r')
          acked = Date.now()
        }
        return screen().includes(text)
      },
      25_000,
      `"${text}" on screen`,
      () => raw,
    )
  }
  return {
    screen,
    send,
    async say(text) {
      // a key written right after the screen rendered can be dropped: retry until it shows
      // the draft is a row of its own (no prompt mark), the sent message sits after the user's `› `
      const mark = screen().length
      const shown = new RegExp(`(^|\\n)[ ›]*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
      let last = 0
      await until(
        () => {
          if (Date.now() - last > 1500 && !shown.test(screen().slice(mark))) {
            send(text)
            last = Date.now()
          }
          return shown.test(screen().slice(mark))
        },
        20_000,
        `typed "${text}"`,
        () => raw,
      )
      send('\r')
    },
    stop: () => stopProc(proc),
  }
}

export type { Child }
