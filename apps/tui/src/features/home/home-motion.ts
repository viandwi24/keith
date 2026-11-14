/** What the owner can set about Home's motion (`platform/config.ts` reads it from the environment). */
export interface HomeMotion {
  /** Play the staged fade-in the first time Home appears in a process. */
  intro: boolean
  /** Seconds without a key before the graph, legend, title and status fade out; 0 never hides. */
  idleHideSeconds: number
}

export const DEFAULT_HOME_MOTION: HomeMotion = { intro: true, idleHideSeconds: 60 }

/** The parts of Home that fade, in the order the intro reveals them (the orb is first). */
export type HomePart = 'orb' | 'graph' | 'legend' | 'title'
const ORDER: readonly HomePart[] = ['orb', 'graph', 'legend', 'title']

/** Time between the start of one stage and the next, and the fade of each (about 1.25 s in all). */
export const STAGE_MS = 300
export const STAGE_FADE_MS = 350
export const INTRO_MS = STAGE_MS * (ORDER.length - 1) + STAGE_FADE_MS

export const stageDelay = (part: HomePart): number => ORDER.indexOf(part) * STAGE_MS

let played = false

/**
 * True once per process: the first Home that mounts plays the intro (when it is on); a Home that
 * mounts again (back from the chat, a swapped connection) shows everything at once.
 */
export function claimIntro(enabled: boolean): boolean {
  if (!enabled || played) return false
  played = true
  return true
}

/** Tests only: let the next Home play its intro again. */
export function resetIntro(): void {
  played = false
}
