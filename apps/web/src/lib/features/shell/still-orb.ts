// "Still orb": a setting (localStorage) and `prefers-reduced-motion` both make the orb one static frame.

export const STILL_ORB_KEY = 'keith.stillOrb'

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const platform = (): StorageLike | undefined => {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export function readStillOrb(storage: StorageLike | undefined = platform()): boolean {
  try {
    return storage?.getItem(STILL_ORB_KEY) === 'on'
  } catch {
    return false
  }
}

export function writeStillOrb(on: boolean, storage: StorageLike | undefined = platform()): void {
  try {
    if (on) storage?.setItem(STILL_ORB_KEY, 'on')
    else storage?.removeItem(STILL_ORB_KEY)
  } catch {
    // the choice then lasts until the tab closes
  }
}

/** The orb is drawn once, not animated, when the setting is on or the person asked the system for less motion. */
export const orbIsStill = (setting: boolean, reducedMotion: boolean): boolean =>
  setting || reducedMotion
