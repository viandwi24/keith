import { canFade, FADE_MS, useMotion, useTheme } from '@keith/ui'
import { useEffect, useState } from 'react'
import {
  claimIntro,
  type HomeMotion,
  type HomePart,
  INTRO_MS,
  STAGE_FADE_MS,
  stageDelay,
} from './home-motion.ts'
import { useHomeVeil } from './home-veil.ts'

/**
 * Home's motion: the first Home of the process fades its parts in one after the other (`part`
 * gives the `Reveal` props of each), and after a pause without a key the graph, legend, title and
 * status fade out (`shown`); the orb stays. `touch()` is called for every key and answers `true`
 * when it only woke a hidden screen; `skipIntro()` ends the intro at once.
 */
export function useHomeMotion({ motion, blocked }: { motion: HomeMotion; blocked: boolean }) {
  const theme = useTheme()
  const { scheduler, reduced } = useMotion()
  const [intro0] = useState(() => claimIntro(motion.intro))
  const [playing, setPlaying] = useState(intro0 && !reduced && canFade(theme.depth))
  const [skip, setSkip] = useState(false)
  useEffect(() => {
    if (!playing) return undefined
    return scheduler.after(INTRO_MS + 50, () => setPlaying(false))
  }, [playing, scheduler])
  useEffect(() => {
    if (skip) setSkip(false)
  }, [skip])
  const skipIntro = () => {
    if (!playing) return
    setSkip(true)
    setPlaying(false)
  }
  const veil = useHomeVeil({ idleSeconds: motion.idleHideSeconds, scheduler, blocked })
  const part = (name: HomePart, shown: boolean) => ({
    visible: shown,
    ...(intro0 ? { from: 0 } : {}),
    delayMs: playing ? stageDelay(name) : 0,
    durationMs: playing ? STAGE_FADE_MS : FADE_MS,
    instant: skip,
  })
  return { part, shown: !veil.hidden, skipIntro, touch: veil.touch }
}
