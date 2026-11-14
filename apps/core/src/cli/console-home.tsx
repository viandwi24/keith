// Home screen of `keith-core` when setup is done and core is stopped.
import { G, type Hint, KeyHints, ListRow, Notice, PulseGlyph, Screen, Txt } from '@keith/ui'
import { Box, useInput, useWindowSize } from 'ink'
import { useState } from 'react'
import type { HomeChoice, HomeProps } from './console-types.ts'
import type { Check, Level } from './doctor.ts'

const MENU: Array<{ id: HomeChoice | 'doctor'; label: string; hint: string; key: string }> = [
  { id: 'start', label: 'Start core', hint: 'run it in this terminal', key: 's' },
  { id: 'doctor', label: 'Doctor', hint: 'check that everything is in order', key: 'd' },
  {
    id: 'setup',
    label: 'Run setup again',
    hint: 'name, provider, models, budget, access',
    key: 'r',
  },
  { id: 'quit', label: 'Quit', hint: '', key: 'q' },
]

const MARK: Record<Level, { glyph: string; tone: 'success' | 'warning' | 'danger' }> = {
  ok: { glyph: G.done, tone: 'success' },
  warn: { glyph: G.warn, tone: 'warning' },
  fail: { glyph: G.failed, tone: 'danger' },
}

export function ConsoleHome({
  notice,
  doctor,
  onChoose,
}: HomeProps & { onChoose(choice: HomeChoice): void }) {
  const { columns } = useWindowSize()
  const width = Math.min(columns, 100)
  const [index, setIndex] = useState(0)
  const [checks, setChecks] = useState<Check[] | 'running' | undefined>()
  const [failure, setFailure] = useState<string | undefined>()

  const pick = (id: (typeof MENU)[number]['id']): void => {
    if (id !== 'doctor') {
      onChoose(id)
      return
    }
    if (checks === 'running') return
    setChecks('running')
    setFailure(undefined)
    doctor().then(setChecks, (e: unknown) => {
      setChecks(undefined)
      setFailure(e instanceof Error ? e.message : String(e))
    })
  }
  useInput((input, key) => {
    if (key.upArrow) setIndex((i) => (i + MENU.length - 1) % MENU.length)
    else if (key.downArrow) setIndex((i) => (i + 1) % MENU.length)
    else if (key.return) pick(MENU[index]?.id ?? 'quit')
    else if (key.escape) onChoose('quit')
    else {
      const hit = MENU.findIndex((m) => m.key === input.toLowerCase())
      if (hit >= 0) {
        setIndex(hit)
        pick(MENU[hit]?.id ?? 'quit')
      }
    }
  })
  const hints: Hint[] = [
    { key: '↑↓', action: 'move' },
    { key: 'enter', action: 'choose' },
    { key: 'esc', action: 'quit' },
  ]
  return (
    <Screen title="Keith" subtitle="core is stopped" width={width}>
      <Box flexDirection="column" flexGrow={1}>
        {notice !== undefined && (
          <Box marginBottom={1}>
            <Notice level="info" rows={[notice]} />
          </Box>
        )}
        {MENU.map((m, i) => (
          <ListRow
            key={m.id}
            width={width}
            selected={i === index}
            columns={[
              { text: m.label, width: 20 },
              { text: m.hint, tone: 'muted', flex: true },
            ]}
          />
        ))}
        <Box height={1} />
        {checks === 'running' && (
          <Box>
            <PulseGlyph tone="accent" />
            <Txt> Running the checks</Txt>
          </Box>
        )}
        {Array.isArray(checks) &&
          checks.map((c) => (
            <Box key={c.name}>
              <Txt tone={MARK[c.level].tone}>{`${MARK[c.level].glyph} `}</Txt>
              <Txt>{`${c.name} `}</Txt>
              <Txt tone="muted" wrap="truncate-end">{`${G.sep} ${c.hint}`}</Txt>
            </Box>
          ))}
        {failure !== undefined && <Notice level="error" rows={[`doctor failed: ${failure}`]} />}
      </Box>
      <KeyHints hints={hints} />
    </Screen>
  )
}
