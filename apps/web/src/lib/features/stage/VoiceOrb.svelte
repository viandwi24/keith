<script lang="ts">
import { Orb, type OrbMode, VOICE_ORB_PALETTE, voiceOrbColorOf } from '@keith/ui/orb'
import { onMount } from 'svelte'
import { motion } from '../shell/index.ts'
import { drawVoiceOrb } from './voice-orb-draw.ts'

let { mode, size, label = 'Keith' }: { mode: OrbMode; size: number; label?: string } = $props()

let canvas = $state<HTMLCanvasElement>()
const dpr = $derived(Math.min(2, globalThis.devicePixelRatio || 1))
const orb = new Orb(VOICE_ORB_PALETTE.orb)
let raf = 0
let last = 0

function paint(dt: number): void {
  const ctx = canvas?.getContext('2d')
  if (ctx == null) return
  orb.mode = mode
  const particles = orb.step(dt)
  drawVoiceOrb(ctx, particles, orb.color, orb.amplitude, Math.round(size * dpr))
}

/** One fixed frame in the colour of the mode: still orb setting or reduced motion. */
function paintStill(): void {
  const ctx = canvas?.getContext('2d')
  if (ctx == null) return
  const fixed = new Orb(VOICE_ORB_PALETTE.orb, () => 0.5)
  fixed.mode = mode
  fixed.color = voiceOrbColorOf(mode)
  drawVoiceOrb(ctx, fixed.step(0), fixed.color, fixed.amplitude, Math.round(size * dpr))
}

function frame(now: number): void {
  raf = requestAnimationFrame(frame)
  const dt = last === 0 ? 0 : (now - last) / 1000
  last = now
  paint(dt)
}

function stop(): void {
  if (raf !== 0) cancelAnimationFrame(raf)
  raf = 0
  last = 0
}

function run(): void {
  paint(0)
  if (raf === 0 && !document.hidden) raf = requestAnimationFrame(frame)
}

onMount(() => {
  const onVisibility = (): void => (document.hidden ? stop() : motion.still ? undefined : run())
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    stop()
  }
})

$effect(() => {
  if (canvas === undefined) return undefined
  if (motion.still) {
    stop()
    mode
    size
    dpr
    paintStill()
    return undefined
  }
  run()
  return stop
})
</script>

<div role="img" aria-label="{label} voice orb, currently {mode}" style:width="{size}px" style:height="{size}px">
  <canvas
    bind:this={canvas}
    width={Math.round(size * dpr)}
    height={Math.round(size * dpr)}
    style:width="{size}px"
    style:height="{size}px"
    aria-hidden="true"
  ></canvas>
</div>

<style>
  canvas { display: block; }
</style>
