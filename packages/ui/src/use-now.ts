import { useEffect, useState } from 'react'

/** `now` that ticks every second while `live` (a running task's elapsed time, a countdown). */
export function useNow(live: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!live) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
  return now
}
