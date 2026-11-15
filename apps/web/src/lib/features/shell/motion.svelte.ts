import { orbIsStill, readStillOrb, writeStillOrb } from './still-orb.ts'

/** Whether the orb is still: the "still orb" setting (localStorage) or the system's reduced-motion preference. */
class Motion {
  setting = $state(readStillOrb())
  reduced = $state(false)
  still = $derived(orbIsStill(this.setting, this.reduced))

  /** Follow `prefers-reduced-motion`; returns the stop function. */
  watch(): () => void {
    const query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (query === undefined) return () => undefined
    this.reduced = query.matches
    const onChange = (event: MediaQueryListEvent): void => {
      this.reduced = event.matches
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }

  setStill(on: boolean): void {
    this.setting = on
    writeStillOrb(on)
  }
}

export const motion = new Motion()
