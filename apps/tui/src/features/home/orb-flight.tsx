import { OrbCanvas, type OrbMode } from '@keith/ui'
import { Box } from 'ink'
import { useEffect, useState } from 'react'
import {
  FLIGHT_STEP_MS,
  FLIGHT_STEPS,
  type FlightDirection,
  flightBox,
  flightEnds,
  type OrbBox,
} from './orb-flight.ts'

export interface OrbFlightProps {
  direction: FlightDirection
  columns: number
  rows: number
  mode: OrbMode
  cellAspect: number
  /** The orb's box on the chat when it is not in the header (the top of the wide sidebar). */
  chat?: OrbBox
  /** The last frame passed: show the screen the orb flew to. */
  onDone(): void
}

/**
 * The orb moving between Home and the chat header: a few frames of the orb alone, from the
 * source box to the target box (tui-design 5.17). The timer exists only while this is mounted.
 * It takes no keys: the screens underneath stay live.
 */
export function OrbFlight({
  direction,
  columns,
  rows,
  mode,
  cellAspect,
  chat,
  onDone,
}: OrbFlightProps) {
  const [step, setStep] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setStep((s) => s + 1), FLIGHT_STEP_MS)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (step >= FLIGHT_STEPS) onDone()
  }, [step, onDone])
  const { from, to } = flightEnds(direction, columns, rows, cellAspect, chat)
  const box = flightBox(from, to, Math.min(step, FLIGHT_STEPS))
  return (
    <Box width={columns} height={rows} flexDirection="column">
      <Box marginTop={box.top} marginLeft={box.left} width={box.width} height={box.height}>
        <OrbCanvas mode={mode} width={box.width} height={box.height} cellAspect={cellAspect} />
      </Box>
    </Box>
  )
}
