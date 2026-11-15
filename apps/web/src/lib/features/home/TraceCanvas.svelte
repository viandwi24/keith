<script lang="ts">
import { orbPaletteOf } from '@keith/ui/orb'
import { onMount } from 'svelte'
import { live } from '../live/index.ts'
import { motion, theme } from '../shell/index.ts'
import { drawTrace } from './trace-draw.ts'

let { height = 56 }: { height?: number } = $props()

const BAR = 3
const FRAME_MS = 1000 / 30

let canvas = $state<HTMLCanvasElement>()
let width = $state(0)
const dpr = $derived(Math.min(2, globalThis.devicePixelRatio || 1))
const colors = $derived(orbPaletteOf(theme.name).brain.regions)
let raf = 0
let last = 0

function paint(): void {
  const ctx = canvas?.getContext('2d')
  if (!ctx || width === 0) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  drawTrace(ctx, live.trace.lastSamples(Math.ceil(width / BAR)), colors, width, height, BAR)
}

function frame(now: number): void {
  raf = requestAnimationFrame(frame)
  if (now - last < FRAME_MS) return
  const dt = last === 0 ? 0 : (now - last) / 1000
  last = now
  if (canvas === undefined || canvas.offsetParent === null) return
  live.trace.step(dt)
  paint()
}

function stop(): void {
  if (raf !== 0) cancelAnimationFrame(raf)
  raf = 0
  last = 0
  live.driveTrace = false
}

function run(): void {
  // one frame right away: a browser that throttles or skips animation frames still shows the trace
  paint()
  if (raf !== 0 || document.hidden) return
  live.driveTrace = true
  raf = requestAnimationFrame(frame)
}

onMount(() => {
  const onVisibility = (): void => (document.hidden ? stop() : motion.still ? undefined : run())
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    stop()
  }
})

// still orb or reduced motion: the trace does not scroll; it is drawn again when the width or theme changes
$effect(() => {
  if (canvas === undefined) return undefined
  if (motion.still) {
    stop()
    colors
    width
    paint()
    return undefined
  }
  run()
  return stop
})
</script>

<div class="trace" bind:clientWidth={width} style:height="{height}px" role="img" aria-label="Brain activity">
  <canvas
    bind:this={canvas}
    width={Math.max(1, Math.round(width * dpr))}
    height={Math.round(height * dpr)}
    style:width="{width}px"
    style:height="{height}px"
    aria-hidden="true"
  ></canvas>
</div>

<style>
  .trace { width: 100%; }
  canvas { display: block; }
</style>
