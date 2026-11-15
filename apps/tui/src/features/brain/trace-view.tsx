import { traceText } from '@keith/app-model'
import { ScrollView, Txt, useFooter } from '@keith/ui'
import { Box } from 'ink'
import type { BrainState } from './brain-state.ts'

const clock = (at: number): string => new Date(at).toTimeString().slice(0, 8)

const FOOTER = [{ key: 'esc', action: 'back' }] as const

/** `/brain trace`: the last events with their arrival time, newest last, sticking to the bottom. */
export function TraceView({ state, width }: { state: BrainState; width: number }) {
  useFooter(FOOTER)
  const n = state.trace.length
  if (n === 0) {
    return <Txt tone="muted">No brain events yet. Send a message and they appear here.</Txt>
  }
  return (
    <Box flexDirection="column" flexGrow={1} width={width}>
      <Txt tone="muted">{`last ${n} ${n === 1 ? 'event' : 'events'}`}</Txt>
      <Box height={1} flexShrink={0} />
      <ScrollView>
        {state.trace.map((e, i) => (
          <Box key={i}>
            <Box flexShrink={0}>
              <Txt tone="muted">{`${clock(e.at)}  `}</Txt>
              <Txt>{e.region.padEnd(10)}</Txt>
              <Txt>{` `}</Txt>
            </Box>
            <Txt wrap="truncate-end">{traceText(e)}</Txt>
          </Box>
        ))}
      </ScrollView>
    </Box>
  )
}
