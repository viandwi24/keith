// What Ink does not give: the mouse wheel and whether the terminal speaks the Kitty keyboard
// protocol. Ink has no mouse API and keeps its Kitty state private, so the app looks at the bytes
// itself, in front of Ink, and passes everything else on untouched.

const ESC = String.fromCharCode(27)
/** SGR mouse report: `ESC[<button;column;row` then `M` (press, wheel) or `m` (release). */
const MOUSE = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, 'g')
/** The start of a mouse report whose end has not arrived yet (never a bare `ESC`, that is the key). */
const MOUSE_PARTIAL = new RegExp(`${ESC}\\[<[\\d;]*$`)
/** The terminal's answer to Ink's `ESC[?u` query: it speaks the Kitty keyboard protocol. */
const KITTY_REPLY = new RegExp(`${ESC}\\[\\?\\d+u`)
/** `shift+enter` as the protocol reports it: `ESC[13;<mods>u` (mods - 1 has the shift bit). */
const KITTY_ENTER = new RegExp(`${ESC}\\[13;(\\d+)(?::\\d+)?u`, 'g')

export interface Scanned {
  /** What Ink should read: the input without mouse reports. */
  text: string
  /** Wheel notches in order: -1 up (older rows), 1 down. Other buttons, motion and clicks are dropped. */
  wheel: number[]
  /** The terminal answered the Kitty query, or a `shift+enter` arrived as a Kitty sequence. */
  kitty: boolean
  /** The unfinished start of a mouse report: prepend it to the next chunk. */
  pending: string
}

/** Split a chunk of terminal input into what Ink reads, wheel notches and the Kitty evidence. */
export function scanInput(chunk: string, pending = ''): Scanned {
  let input = pending + chunk
  let held = ''
  const partial = MOUSE_PARTIAL.exec(input)
  if (partial !== null) {
    held = partial[0]
    input = input.slice(0, partial.index)
  }
  const wheel: number[] = []
  const text = input.replace(MOUSE, (_all, button: string) => {
    const code = Number(button)
    // wheel: bit 64 set, motion bit 32 clear, the low two bits say up (0) or down (1); 2 and 3 are sideways
    if (code & 64 && !(code & 32)) {
      const dir = code & 3
      if (dir === 0) wheel.push(-1)
      else if (dir === 1) wheel.push(1)
    }
    return ''
  })
  let kitty = KITTY_REPLY.test(input)
  for (const m of input.matchAll(KITTY_ENTER)) {
    if ((Number(m[1]) - 1) & 1) kitty = true
  }
  return { text, wheel, kitty, pending: held }
}

type Listener = () => void

/** Whether the terminal reports `shift+enter` (the Kitty keyboard protocol): decides the newline hint. */
export const kittyKeys = (() => {
  let supported = false
  const listeners = new Set<Listener>()
  return {
    get: (): boolean => supported,
    set(value: boolean): void {
      if (value === supported) return
      supported = value
      for (const l of [...listeners]) l()
    },
    subscribe(l: Listener): () => void {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
  }
})()

export interface InputStream {
  isTTY?: boolean
  read(size?: number): string | Buffer | null
}

/**
 * Put a filter in front of Ink's reads. Ink reads with `stdin.read()` in a `readable` listener, so
 * an extra `data` listener would switch the stream to flowing mode and starve it; replacing `read`
 * on the stream instance keeps Ink's own loop and hands it the text without mouse reports.
 * Returns the function that puts the original back.
 */
export function filterInput(
  stream: InputStream,
  handlers: { onWheel(lines: number): void; onKitty(): void },
  wheelLines = 3,
): () => void {
  if (stream.isTTY !== true) return () => {}
  const unpatched = stream.read
  const original = unpatched.bind(stream)
  let pending = ''
  stream.read = (size?: number) => {
    const chunk = original(size)
    if (chunk === null) return null
    const scanned = scanInput(typeof chunk === 'string' ? chunk : chunk.toString('utf8'), pending)
    pending = scanned.pending
    if (scanned.kitty) handlers.onKitty()
    for (const dir of scanned.wheel) handlers.onWheel(dir * wheelLines)
    // an empty string, not null: Ink's loop goes on to the next buffered chunk
    return scanned.text
  }
  return () => {
    stream.read = unpatched
  }
}

export const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`
export const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1000l`

export interface Mouse {
  enabled(): boolean
  /** `/mouse on` and `/mouse off` (the session only). */
  set(on: boolean): void
}

/**
 * Mouse reporting for the wheel. The terminal must never be left in mouse mode: `dispose` switches
 * it off and is also hooked to `exit` (normal end, `process.exit`, an uncaught error) and to the
 * termination signals.
 */
export function createMouse(
  write: (text: string) => void,
  options: { hookProcess?: boolean } = {},
): Mouse & { dispose(): void } {
  let on = false
  const set = (next: boolean) => {
    if (next === on) return
    on = next
    write(next ? MOUSE_ON : MOUSE_OFF)
  }
  const dispose = () => {
    // always written, even when the flag says off: a lost state must still clean the terminal
    on = false
    write(MOUSE_OFF)
  }
  if (options.hookProcess === true) {
    process.on('exit', dispose)
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(signal, () => {
        dispose()
        // SIGTERM has its own graceful handler in cli.tsx; the others end the process here
        if (signal !== 'SIGTERM') process.exit(signal === 'SIGINT' ? 130 : 129)
      })
    }
  }
  return { enabled: () => on, set, dispose }
}
