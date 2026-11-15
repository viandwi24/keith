<script lang="ts">
import { Orb, type OrbMode, orbPaletteOf } from '@keith/ui/orb'
import { onMount } from 'svelte'
import { motion, theme } from '../shell/index.ts'
import { drawOrb } from './orb-draw.ts'

let { mode, size, label = 'Keith' }: { mode: OrbMode; size: number; label?: string } = $props()

/** 30 frames a second is plenty for slow waves and keeps the laptop cool. */
const FRAME_MS = 1000 / 30

let canvas = $state<HTMLCanvasElement>()
const palette = $derived(orbPaletteOf(theme.name))
const dpr = $derived(Math.min(2, globalThis.devicePixelRatio || 1))
let orb: Orb | undefined
let raf = 0
let last = 0

function ctxOf(): CanvasRenderingContext2D | undefined {
  return canvas?.getContext('2d') ?? undefined
}

function paint(dt: number): void {
  const ctx = ctxOf()
  if (ctx === undefined || orb === undefined) return
  orb.mode = mode
  const particles = orb.step(dt)
  const px = size * dpr
  drawOrb(ctx, particles, orb.color, px, Math.max(1.2, px / 260))
}

/** One fixed frame: frame 0 of a model that never steps, in the colour of the mode. */
function paintStill(): void {
  const ctx = ctxOf()
  if (ctx === undefined) return
  const fixed = new Orb(palette.orb, () => 0.5)
  fixed.mode = mode
  fixed.color = [...palette.orb[mode]]
  const px = size * dpr
  drawOrb(ctx, fixed.step(0), fixed.color, px, Math.max(1.2, px / 260))
}

function frame(now: number): void {
  raf = requestAnimationFrame(frame)
  if (now - last < FRAME_MS) return
  const dt = last === 0 ? 0 : (now - last) / 1000
  last = now
  // a canvas that is not displayed (the inspector below 1100 px, a collapsed drawer) costs nothing
  if (canvas === undefined || canvas.offsetParent === null) return
  paint(dt)
}

function stop(): void {
  if (raf !== 0) cancelAnimationFrame(raf)
  raf = 0
  last = 0
}

function run(): void {
  // one frame right away: a browser that throttles or skips animation frames still shows the orb
  if (canvas !== undefined && canvas.offsetParent !== null) paint(0)
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

// the colours follow the theme: a new model keeps the colour it had so the switch does not flash
$effect(() => {
  const colors = palette.orb
  const next = new Orb(colors)
  if (orb !== undefined) next.color = [...orb.color]
  orb = next
})

// animated: a frame loop; still (setting or reduced motion): one frame, redrawn when what it shows changes
$effect(() => {
  if (canvas === undefined) return undefined
  if (motion.still) {
    stop()
    palette
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

<div class="orb" role="img" aria-label="{label}: {mode}" style:width="{size}px" style:height="{size}px">
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
