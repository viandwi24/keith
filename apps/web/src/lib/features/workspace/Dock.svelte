<script lang="ts">
import type { WorkspaceShowInput } from '@keith/contracts'
import type { Snippet } from 'svelte'
import { appOf } from './apps.ts'
import { LAYOUTS, type LayoutPreset, MAX_DESKTOPS } from './model.ts'
import { workspace } from './workspace.svelte.ts'

// The dock at the bottom of the workspace: the small orb (back to ambient), the desktops, the app launcher, the layout presets, the
// minimised windows, the overview button, and Keith's chips: what he asked to show while the person was busy, and an undo of his
// latest change.

let { orb }: { orb?: Snippet } = $props()

const REFUSED: Record<string, string> = {
  'desktop-limit': `At most ${MAX_DESKTOPS} desktops`,
  'window-limit': 'This desktop is full (12 windows)',
  'last-desktop': 'The last desktop stays',
  'nothing-to-undo': "Nothing of Keith's to undo",
  'unknown-app': 'That app is not available',
  'bad-params': 'That app cannot open with these settings',
}

const LAYOUT_LABEL: Record<LayoutPreset, string> = {
  focus: 'Focus: one window',
  split: 'Split: one left, the rest right',
  stack: 'Stack: rows',
  grid: 'Grid',
  free: 'Free: where you drag them',
}

let launcher = $state(false)
const minimised = $derived(workspace.desktop.windows.filter((w) => w.state === 'min'))

function open(id: string): void {
  launcher = false
  workspace.openApp(id)
}

/** What a held chip opens, in a few words. */
function heldLabel(held: WorkspaceShowInput): string {
  if ('overview' in held) return 'OVERVIEW'
  if ('ambient' in held) return 'ORB'
  const desktop = workspace.doc.desktops.find((d) => d.id === held.desktopId)
  const window = desktop?.windows.find((w) => w.id === held.windowId)
  return (window?.title ?? desktop?.name ?? 'SHOW').slice(0, 24)
}

function onkey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && launcher) launcher = false
}
</script>

<svelte:window onkeydown={onkey} />

<nav class="dock" aria-label="Workspace dock">
  <button type="button" class="orb" aria-label="Back to the orb" title="Back to the orb" onclick={() => workspace.setMode('ambient')}>
    {@render orb?.()}
  </button>

  <div class="group desktops" role="tablist" aria-label="Desktops">
    {#each workspace.doc.desktops as d (d.id)}
      <button
        type="button"
        role="tab"
        aria-selected={workspace.mode === 'workspace' && d.id === workspace.desktop.id}
        class:on={workspace.mode === 'workspace' && d.id === workspace.desktop.id}
        onclick={() => workspace.show(d.id)}
      >
        {d.name}{#if d.windows.length > 0}<span class="count">{d.windows.length}</span>{/if}
      </button>
    {/each}
    <button type="button" class="icon" aria-label="Add a desktop" title="Add a desktop" onclick={() => workspace.addDesktop()}>+</button>
  </div>

  <div class="group launch">
    <button type="button" aria-expanded={launcher} aria-controls="dock-apps" onclick={() => (launcher = !launcher)}>APPS</button>
    {#if launcher}
      <ul id="dock-apps" class="apps">
        {#each workspace.apps as app (app.id)}
          <li>
            <button type="button" onclick={() => open(app.id)}>
              <span class="glyph" aria-hidden="true">{app.glyph}</span>{app.title}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#if workspace.mode === 'workspace'}
    <div class="group layouts" role="radiogroup" aria-label="Layout">
      {#each LAYOUTS as l (l)}
        <button
          type="button"
          role="radio"
          aria-checked={workspace.desktop.layout === l}
          class:on={workspace.desktop.layout === l}
          title={LAYOUT_LABEL[l]}
          aria-label={LAYOUT_LABEL[l]}
          onclick={() => workspace.setLayout(l)}
        >
          <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
            {#if l === 'focus'}<rect x="1" y="1" width="12" height="10" />
            {:else if l === 'split'}<rect x="1" y="1" width="6" height="10" /><rect x="8" y="1" width="5" height="4.5" /><rect x="8" y="6.5" width="5" height="4.5" />
            {:else if l === 'stack'}<rect x="1" y="1" width="12" height="2.6" /><rect x="1" y="4.7" width="12" height="2.6" /><rect x="1" y="8.4" width="12" height="2.6" />
            {:else if l === 'grid'}<rect x="1" y="1" width="5.5" height="4.5" /><rect x="7.5" y="1" width="5.5" height="4.5" /><rect x="1" y="6.5" width="5.5" height="4.5" /><rect x="7.5" y="6.5" width="5.5" height="4.5" />
            {:else}<rect x="1" y="2" width="7" height="6" /><rect x="5" y="4" width="8" height="7" />{/if}
          </svg>
        </button>
      {/each}
    </div>
  {/if}

  {#if minimised.length > 0}
    <div class="group minimised" aria-label="Minimised windows">
      {#each minimised as w (w.id)}
        <button type="button" title="Restore {w.title}" onclick={() => workspace.apply({ op: 'window.focus', id: w.id })}>
          <span class="glyph" aria-hidden="true">{appOf(w.app, workspace.apps)?.glyph ?? '□'}</span>{w.title}
        </button>
      {/each}
    </div>
  {/if}

  <button
    type="button"
    class="overview"
    aria-pressed={workspace.mode === 'overview'}
    class:on={workspace.mode === 'overview'}
    onclick={() => workspace.setMode(workspace.mode === 'overview' ? 'workspace' : 'overview')}
  >
    OVERVIEW
  </button>

  {#if workspace.held !== undefined}
    <span class="group keith" role="status">
      <button type="button" class="chip" onclick={() => workspace.openHeld()}>KEITH · {heldLabel(workspace.held)}</button>
      <button type="button" class="icon" aria-label="Dismiss" title="Dismiss" onclick={() => workspace.dismissHeld()}>×</button>
    </span>
  {/if}

  {#if workspace.keithChanged}
    <button type="button" class="chip" onclick={() => void workspace.undoKeith()}>UNDO KEITH</button>
  {/if}

  {#if workspace.refused !== undefined}
    <span class="note" role="status">{REFUSED[workspace.refused] ?? 'Not possible'}</span>
  {/if}
</nav>

<style>
  .dock {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    padding: 6px 8px;
    box-sizing: border-box;
    background: var(--hud-fill);
    border: 1px solid var(--hud-border);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.16em;
    color: var(--hud-muted);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .group { display: flex; align-items: center; gap: 2px; padding-left: 6px; border-left: 1px dashed var(--hud-rule); }
  button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 8px;
    background: none;
    border: 1px solid transparent;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    white-space: nowrap;
    cursor: pointer;
  }
  button:hover, button:focus-visible { color: var(--hud-title); border-color: var(--hud-border); }
  button.on { color: var(--hud-title); border-color: var(--hud-bracket); }
  .orb { width: 40px; height: 40px; padding: 0; justify-content: center; flex: none; }
  .icon { width: 28px; justify-content: center; padding: 0; }
  .count { font-size: 9px; color: var(--hud-muted); }
  .glyph { width: 12px; text-align: center; letter-spacing: 0; }
  .layouts svg { fill: none; stroke: currentColor; stroke-width: 1; }
  .layouts button { padding: 0 6px; }
  .launch { position: static; }
  .apps {
    position: fixed;
    bottom: 68px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 20;
    list-style: none;
    margin: 0;
    padding: 6px;
    display: grid;
    grid-template-columns: repeat(2, minmax(120px, 1fr));
    gap: 2px;
    background: var(--hud-fill);
    border: 1px solid var(--hud-border);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .apps button { width: 100%; }
  .overview { margin-left: 2px; border-left: 1px dashed var(--hud-rule); }
  .chip { color: var(--hud-title); border-color: var(--hud-bracket); }
  .note { padding: 0 8px; color: var(--hud-title); white-space: nowrap; }
</style>
