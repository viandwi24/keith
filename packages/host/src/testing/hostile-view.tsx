import { Text, useStdout } from 'ink'
import { useEffect } from 'react'
import { z } from 'zod'
import { defineKeithPlugin, defineOperation } from '../define.ts'
import { useKeith } from '../tui/context.tsx'

const ESC = '\u001b'
const BEL = '\u0007'

/**
 * What a hostile view writes to its output: a clipboard write (OSC 52), a window title, hyperlink, device-report requests, a
 * cursor and screen reset, a DCS, an APC, a C1 introducer and a bidi override. `useStdout().write` is raw (Ink scrubs
 * only what is inside `<Text>`), so a view that reaches for Ink directly puts these bytes into its frames; the client must
 * drop every one of them (docs/specs/plugin-views.md, "Sanitiser rules").
 */
export const HOSTILE_BYTES: readonly string[] = [
  `${ESC}]52;c;aGlqYWNrZWQ=${BEL}`,
  `${ESC}]0;pwned-title${BEL}`,
  `${ESC}]8;;https://evil.example/${ESC}\\link${ESC}]8;;${ESC}\\`,
  `${ESC}[6n${ESC}[c${ESC}[?u`,
  `${ESC}[2J${ESC}[H${ESC}c`,
  `${ESC}Pq#0;2;0;0;0${ESC}\\`,
  `${ESC}_Gi=1;AAAA${ESC}\\`,
  '\u009b31m\u009d0;pwned\u0007',
  'gnp.exe‮evil',
]

/** A view that prints the hostile bytes raw, then a line of honest text. */
function Raw() {
  const { write } = useStdout()
  useEffect(() => {
    // after the first frame exists: Ink puts a raw write in front of the current frame, in one write the sink keeps
    const timer = setTimeout(() => write(`${HOSTILE_BYTES.join('\n')}\n`), 80)
    return () => clearTimeout(timer)
  }, [write])
  return <Text color="red">honest text after the attack</Text>
}

/** A view that draws far more than a frame may hold (`params.lines` rows of 200 cells). */
function Flood({ params }: { params: Readonly<Record<string, string>> }) {
  const lines = Number(params.lines ?? '2000')
  return (
    <Text>{Array.from({ length: lines }, (_, i) => `${i}:${'x'.repeat(200)}`).join('\n')}</Text>
  )
}

/** A view that asks the platform for what a view should not have. */
function Greedy() {
  const k = useKeith()
  return <Text>{Object.keys(k).sort().join(',')}</Text>
}

/**
 * A plugin of hostile views for tests only (never in `BUILTIN_PLUGINS`): the clients and the core are proven against
 * it, not against well-behaved plugins. `hostile.raw` prints escape sequences, `hostile.flood` a frame over the cap.
 */
export const hostilePlugin = defineKeithPlugin({
  id: 'hostile',
  version: '1.0.0',
  apiVersion: 1,
  // a plugin needs one operation: this one only exists so the manifest is valid
  operations: [
    defineOperation({
      name: 'ping',
      description: 'Does nothing.',
      input: z.object({}),
      output: z.object({}),
      permission: { capability: 'authenticated' },
      risk: 'read',
      run: () => ({}),
    }),
  ],
  tui: {
    menu: [
      { id: 'raw', label: 'Raw', view: 'raw' },
      { id: 'flood', label: 'Flood', view: 'flood' },
      { id: 'greedy', label: 'Greedy', view: 'greedy' },
    ],
    views: {
      raw: async () => ({ default: Raw }),
      flood: async () => ({ default: Flood }),
      greedy: async () => ({ default: Greedy }),
    },
  },
})
