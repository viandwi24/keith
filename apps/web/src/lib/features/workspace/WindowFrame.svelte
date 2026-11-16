<script lang="ts">
import type { Snippet } from 'svelte'
import { darkTokenStyle } from './dark-tokens.ts'
import type { PlacedWindow } from './layout.ts'
import type { NormRect, WorkspaceWindow } from './model.ts'

// One window: a HUD frame (title bar with the app glyph, minimise, maximise, close) around an app. Dragging the title bar or the
// corner handle moves the frame by CSS only; the one `window.move` is sent when the pointer is released (ADR-0037 §4).

let {
  win,
  place,
  glyph,
  focused,
  movable,
  area,
  onfocus,
  onclose,
  onstate,
  onmove,
  children,
}: {
  win: WorkspaceWindow
  place: PlacedWindow
  glyph: string
  focused: boolean
  /** False on a narrow screen: one window at a time, no dragging. */
  movable: boolean
  area: { width: number; height: number }
  onfocus: () => void
  onclose: () => void
  onstate: (state: WorkspaceWindow['state']) => void
  onmove: (rect: NormRect) => void
  children: Snippet
} = $props()

const MIN_W = 240
const MIN_H = 160
const tokens = darkTokenStyle()

let drag = $state<
  { kind: 'move' | 'size'; x: number; y: number; dx: number; dy: number } | undefined
>()

const box = $derived.by(() => {
  if (drag === undefined) return place
  if (drag.kind === 'move') return { ...place, x: place.x + drag.dx, y: place.y + drag.dy }
  return { ...place, w: Math.max(MIN_W, place.w + drag.dx), h: Math.max(MIN_H, place.h + drag.dy) }
})

function start(kind: 'move' | 'size', e: PointerEvent): void {
  onfocus()
  if (!movable || e.button !== 0 || win.state === 'max') return
  if ((e.target as HTMLElement).closest('button') !== null) return
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  drag = { kind, x: e.clientX, y: e.clientY, dx: 0, dy: 0 }
  e.preventDefault()
}

function track(e: PointerEvent): void {
  if (drag === undefined) return
  drag = { ...drag, dx: e.clientX - drag.x, dy: e.clientY - drag.y }
}

function end(): void {
  if (drag === undefined) return
  const moved = Math.abs(drag.dx) + Math.abs(drag.dy) > 3
  const b = box
  drag = undefined
  if (moved && area.width > 0 && area.height > 0)
    onmove({ x: b.x / area.width, y: b.y / area.height, w: b.w / area.width, h: b.h / area.height })
}
</script>

<section
  class="window"
  class:focused
  class:dragging={drag !== undefined}
  style:left="{box.x}px"
  style:top="{box.y}px"
  style:width="{box.w}px"
  style:height="{box.h}px"
  style:z-index={win.z}
  aria-label={win.title}
  onpointerdowncapture={onfocus}
>
  <span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>
  <div
    class="bar"
    role="toolbar"
    tabindex="-1"
    aria-label="{win.title} window"
    class:movable
    onpointerdown={(e) => start('move', e)}
    onpointermove={track}
    onpointerup={end}
    onpointercancel={end}
    ondblclick={() => onstate(win.state === 'max' ? 'normal' : 'max')}
  >
    <span class="glyph" aria-hidden="true">{glyph}</span>
    <span class="title">{win.title}</span>
    {#if win.openedBy === 'keith'}<span class="by" title="Opened by Keith">KEITH</span>{/if}
    <span class="actions">
      <button type="button" aria-label="Minimise {win.title}" onclick={() => onstate('min')}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 8h8" stroke="currentColor" stroke-width="1.4" /></svg>
      </button>
      <button
        type="button"
        aria-label={win.state === 'max' ? `Restore ${win.title}` : `Maximise ${win.title}`}
        onclick={() => onstate(win.state === 'max' ? 'normal' : 'max')}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"
          ><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.4" /></svg
        >
      </button>
      <button type="button" aria-label="Close {win.title}" onclick={onclose}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"
          ><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" /></svg
        >
      </button>
    </span>
  </div>
  <div class="body" style={tokens}>
    {@render children()}
  </div>
  {#if movable && win.state !== 'max'}
    <span
      class="grip"
      aria-hidden="true"
      onpointerdown={(e) => start('size', e)}
      onpointermove={track}
      onpointerup={end}
      onpointercancel={end}
    ></span>
  {/if}
</section>

<style>
  .window {
    position: absolute;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--hud-fill);
    border: 1px solid var(--hud-border);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    color: var(--hud-text);
    font-family: var(--font-mono);
    transition: left 0.18s ease, top 0.18s ease, width 0.18s ease, height 0.18s ease;
  }
  .window.dragging { transition: none; user-select: none; }
  @media (prefers-reduced-motion: reduce) { .window { transition: none; } }
  .corner { position: absolute; width: 10px; height: 10px; border: 0 solid var(--hud-muted); z-index: 1; pointer-events: none; }
  .focused .corner { border-color: var(--hud-bracket); }
  .tl { left: -1px; top: -1px; border-left-width: 2px; border-top-width: 2px; }
  .tr { right: -1px; top: -1px; border-right-width: 2px; border-top-width: 2px; }
  .bl { left: -1px; bottom: -1px; border-left-width: 2px; border-bottom-width: 2px; }
  .br { right: -1px; bottom: -1px; border-right-width: 2px; border-bottom-width: 2px; }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    flex: none;
    padding: 0 6px 0 12px;
    border-bottom: 1px dashed var(--hud-rule);
    font-size: 10px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--hud-muted);
    touch-action: none;
  }
  .bar.movable { cursor: grab; }
  .dragging .bar { cursor: grabbing; }
  .focused .bar { color: var(--hud-title); }
  .glyph { width: 12px; text-align: center; letter-spacing: 0; }
  .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .by { font-size: 8px; letter-spacing: 0.18em; padding: 1px 4px; border: 1px solid var(--hud-border); color: var(--hud-muted); }
  .actions { margin-left: auto; display: flex; gap: 2px; }
  .actions button {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    background: none;
    border: 1px solid transparent;
    color: var(--hud-muted);
    cursor: pointer;
  }
  .actions button:hover, .actions button:focus-visible { color: var(--hud-title); border-color: var(--hud-border); }
  .body {
    /* app.css derives these at :root; derive them again from the dark tokens set on this element */
    --border: var(--k-border);
    --surface: color-mix(in srgb, var(--k-text) 4%, var(--k-bg));
    --surface-strong: color-mix(in srgb, var(--k-text) 9%, var(--k-bg));
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: color-mix(in srgb, var(--k-bg) 88%, transparent);
    color: var(--k-text);
    font-family: var(--font-ui);
  }
  .grip { position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize; touch-action: none; z-index: 2; }
</style>
