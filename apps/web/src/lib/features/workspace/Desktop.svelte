<script lang="ts">
import AppView from './AppView.svelte'
import { appOf } from './apps.ts'
import { NARROW_WIDTH, placeWindows } from './layout.ts'
import { focusedOf, type NormRect, type WorkspaceOp } from './model.ts'
import WindowFrame from './WindowFrame.svelte'
import { workspace } from './workspace.svelte.ts'

// The desktop shown: its windows placed by the desktop's layout preset (`layout.ts`) in the area this element measures.

let width = $state(0)
let height = $state(0)
const area = $derived({ width, height })
const desktop = $derived(workspace.desktop)
const placed = $derived(placeWindows(desktop, area))
const top = $derived(focusedOf(desktop))

function move(id: string, rect: NormRect): void {
  // leaving a preset: every window keeps where it was drawn, then the dragged one moves (one change)
  const ops: WorkspaceOp[] = []
  if (desktop.layout !== 'free' && width > 0 && height > 0) {
    const rects: Record<string, NormRect> = {}
    for (const p of placed)
      if (!p.hidden)
        rects[p.id] = { x: p.x / width, y: p.y / height, w: p.w / width, h: p.h / height }
    ops.push({ op: 'desktop.layout', id: desktop.id, layout: 'free', rects })
  }
  ops.push({ op: 'window.move', id, rect })
  workspace.applyAll(ops)
}
</script>

<div class="desktop" bind:clientWidth={width} bind:clientHeight={height}>
  {#if width > 0}
    {#each desktop.windows as win, i (win.id)}
      {@const place = placed[i]}
      {#if place !== undefined && !place.hidden}
        <WindowFrame
          {win}
          {place}
          {area}
          movable={width >= NARROW_WIDTH}
          glyph={appOf(win.app, workspace.apps)?.glyph ?? '□'}
          focused={top?.id === win.id}
          onfocus={() => {
            if (top?.id !== win.id) workspace.apply({ op: 'window.focus', id: win.id })
          }}
          onclose={() => workspace.apply({ op: 'window.close', id: win.id })}
          onstate={(state) => workspace.apply({ op: 'window.setState', id: win.id, state })}
          onmove={(rect) => move(win.id, rect)}
        >
          <AppView app={win.app} params={win.params} windowId={win.id} />
        </WindowFrame>
      {/if}
    {:else}
      <p class="empty">{desktop.name} is empty. Open an app from the dock.</p>
    {/each}
  {/if}
</div>

<style>
  .desktop { position: relative; width: 100%; height: 100%; }
  .empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    margin: 0;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.18em;
    color: var(--hud-muted);
    text-align: center;
  }
</style>
