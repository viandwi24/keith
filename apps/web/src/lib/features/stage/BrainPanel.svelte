<script lang="ts">
import { type OrbMode, VOICE_ORB_PALETTE } from '@keith/ui/orb'
import { onMount } from 'svelte'
import { live } from '../live/index.ts'
import { motion } from '../shell/index.ts'
import { drawBrainDots, type RegionCell, regionRows, trailOf } from './brain-draw.ts'
import { readPanelExpanded, writePanelExpanded } from './panel-state.ts'
import { rgbText } from './voice-orb-draw.ts'

// The brain trace as a HUD panel. Collapsed (the default): the title, the orb's mode, the dot graph and the trail. Expanded: the
// region list too, between the graph and the trail. The choice is kept per browser (`panel-state.ts`).
// It drives the shared trace (`live.driveTrace`) while it animates, like Home's wave did.

let { mode }: { mode: OrbMode } = $props()

const GRAPH_HEIGHT = 42
/** The list and the trail change slowly: they are read again ten times a second, not every frame. */
const VIEW_MS = 100
/** About one character of the 11 px mono font, for fitting the trail. */
const CHAR_PX = 6.6

const p = VOICE_ORB_PALETTE
let canvas = $state<HTMLCanvasElement>()
let graphWidth = $state(0)
let panelWidth = $state(0)
const dpr = $derived(Math.min(2, globalThis.devicePixelRatio || 1))
let rows = $state.raw<RegionCell[][]>(regionRows(live.trace, p.brain))
let trail = $state.raw(trailOf(live.trace, p.brain, 40))
let expanded = $state(readPanelExpanded('brain'))
const listId = `brain-regions-${Math.random().toString(36).slice(2, 8)}`
const modeColor = $derived(`rgb(${rgbText(p.orb[mode])})`)
let raf = 0
let last = 0
let lastView = 0

function paint(): void {
  const ctx = canvas?.getContext('2d')
  if (!ctx || graphWidth === 0) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  drawBrainDots(
    ctx,
    live.trace.lastSamples(Math.ceil(graphWidth)),
    p.brain.regions,
    graphWidth,
    GRAPH_HEIGHT,
  )
}

function toggle(): void {
  expanded = !expanded
  writePanelExpanded('brain', expanded)
  readView()
}

function readView(): void {
  if (expanded) rows = regionRows(live.trace, p.brain)
  trail = trailOf(live.trace, p.brain, Math.max(8, Math.floor((panelWidth - 32) / CHAR_PX)))
}

function frame(now: number): void {
  raf = requestAnimationFrame(frame)
  const dt = last === 0 ? 0 : (now - last) / 1000
  last = now
  live.trace.step(dt)
  paint()
  if (now - lastView >= VIEW_MS) {
    lastView = now
    readView()
  }
}

function stop(): void {
  if (raf !== 0) cancelAnimationFrame(raf)
  raf = 0
  last = 0
  live.driveTrace = false
}

function run(): void {
  paint()
  readView()
  if (raf !== 0 || document.hidden) return
  live.driveTrace = true
  raf = requestAnimationFrame(frame)
}

onMount(() => {
  const onVisibility = (): void => (document.hidden ? stop() : motion.still ? undefined : run())
  document.addEventListener('visibilitychange', onVisibility)
  // still: the trace is not stepped here (live's coarse timer keeps it decaying); the panel is read again now and then
  const slow = setInterval(() => {
    if (motion.still) {
      paint()
      readView()
    }
  }, 1000)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    clearInterval(slow)
    stop()
  }
})

$effect(() => {
  if (canvas === undefined) return undefined
  if (motion.still) {
    stop()
    graphWidth
    paint()
    readView()
    return undefined
  }
  run()
  return stop
})
</script>

<section
  class="panel"
  aria-label="Brain activity"
  bind:clientWidth={panelWidth}
  style:--hud-fill={p.panel.fill}
  style:--hud-border={p.panel.border}
  style:--hud-bracket={p.panel.bracket}
  style:--hud-rule={p.panel.rule}
  style:--hud-title={p.panel.title}
  style:--hud-text={p.panel.text}
  style:--hud-muted={p.panel.muted}
>
  <span class="corner tl" aria-hidden="true"></span><span class="corner tr" aria-hidden="true"></span>
  <span class="corner bl" aria-hidden="true"></span><span class="corner br" aria-hidden="true"></span>

  <header>
    <span class="title">BRAIN</span>
    <span class="status" style:color={modeColor}><span class="dot" aria-hidden="true"></span>{mode.toUpperCase()}</span>
    <button
      class="toggle"
      type="button"
      aria-expanded={expanded}
      aria-controls={listId}
      aria-label={expanded ? 'Hide regions' : 'Show regions'}
      title={expanded ? 'Hide regions' : 'Show regions'}
      onclick={toggle}
    >
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" class:open={expanded}>
        <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" />
      </svg>
    </button>
  </header>

  <div class="body">
    <div class="graph" bind:clientWidth={graphWidth} style:height="{GRAPH_HEIGHT}px">
      <canvas
        bind:this={canvas}
        width={Math.max(1, Math.round(graphWidth * dpr))}
        height={Math.round(GRAPH_HEIGHT * dpr)}
        style:width="{graphWidth}px"
        style:height="{GRAPH_HEIGHT}px"
        aria-hidden="true"
      ></canvas>
    </div>
    {#if expanded}
      <ul class="regions" id={listId} aria-label="Regions">
        {#each rows.flat() as cell (cell.region)}
          <li style:color={cell.color} class:lit={cell.lit}>
            <span aria-hidden="true">{cell.lit ? '●' : '○'}</span>
            <span class="name">{cell.label}</span>
            <span class="bar" aria-hidden="true">{cell.bar}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <p class="trail" aria-live="off">
    {#if trail.length === 0}
      <span class="muted">no activity yet</span>
    {:else}
      {#each trail as step, i (i)}
        {#if i > 0}<span class="muted sep" aria-hidden="true">›</span>{/if}<span style:color={step.color}>{step.region}</span>
      {/each}
    {/if}
  </p>
</section>

<style>
  .panel {
    position: relative;
    box-sizing: border-box;
    width: 100%;
    background: var(--hud-fill);
    border: 1px solid var(--hud-border);
    padding: 12px 16px 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    color: var(--hud-text);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .corner { position: absolute; width: 10px; height: 10px; border: 0 solid var(--hud-bracket); }
  .tl { left: -1px; top: -1px; border-left-width: 2px; border-top-width: 2px; }
  .tr { right: -1px; top: -1px; border-right-width: 2px; border-top-width: 2px; }
  .bl { left: -1px; bottom: -1px; border-left-width: 2px; border-bottom-width: 2px; }
  .br { right: -1px; bottom: -1px; border-right-width: 2px; border-bottom-width: 2px; }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-bottom: 8px;
    border-bottom: 1px dashed var(--hud-rule);
  }
  .title { font-size: 11px; font-weight: 600; letter-spacing: 0.24em; color: var(--hud-title); }
  .status { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: 9px; letter-spacing: 0.18em; }
  .toggle {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    margin: -6px -8px -6px 0;
    padding: 0;
    background: none;
    border: 1px solid transparent;
    color: var(--hud-muted);
    cursor: pointer;
  }
  .toggle:hover { color: var(--hud-title); border-color: var(--hud-border); }
  .toggle svg { transition: transform 0.15s ease; }
  .toggle svg.open { transform: rotate(180deg); }
  @media (prefers-reduced-motion: reduce) { .toggle svg { transition: none; } }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .body { display: flex; flex-direction: column; gap: 8px; }
  .graph { width: 100%; }
  canvas { display: block; }
  .regions {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    column-gap: 12px;
    row-gap: 0;
    font-size: 10px;
    line-height: 1.45;
  }
  .regions li { display: grid; grid-template-columns: 12px minmax(0, 1fr) 10px; align-items: center; white-space: nowrap; }
  .regions .name { overflow: hidden; text-overflow: ellipsis; }
  .trail { margin: 0; min-height: 1.5em; font-size: 10px; padding-top: 6px; border-top: 1px dashed var(--hud-rule); white-space: nowrap; overflow: hidden; }
  .muted { color: var(--hud-muted); }
  .sep { margin: 0 0.5em; }
</style>
