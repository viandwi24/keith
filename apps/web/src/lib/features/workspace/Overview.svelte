<script lang="ts">
import { appOf } from './apps.ts'
import { SHORTCUTS } from './keys.ts'
import { MAX_DESKTOPS } from './model.ts'
import { workspace } from './workspace.svelte.ts'

// Overview mode: every desktop at once, to choose, add, close, rename or reorder one (P40.4). A card is dragged onto another to take
// its place, or moved with its ◀ ▶ buttons; double-click (or the ✎ button) renames it. Escape goes back to the workspace.

let dragging = $state<string | undefined>()
let editing = $state<string | undefined>()
let draft = $state('')

function onkey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && editing === undefined) workspace.setMode('workspace')
}

function rename(id: string, name: string): void {
  editing = id
  draft = name
}

function commit(): void {
  if (editing !== undefined) workspace.renameDesktop(editing, draft)
  editing = undefined
}

function drop(index: number): void {
  if (dragging !== undefined) workspace.moveDesktop(dragging, index)
  dragging = undefined
}

function focusInput(node: HTMLInputElement): void {
  node.focus()
  node.select()
}
</script>

<svelte:window onkeydown={onkey} />

<section class="overview" aria-label="Every desktop">
  <h2>DESKTOPS <span>{workspace.doc.desktops.length}/{MAX_DESKTOPS}</span></h2>
  <ul>
    {#each workspace.doc.desktops as d, i (d.id)}
      <li
        class:current={d.id === workspace.desktop.id}
        class:dragging={dragging === d.id}
        draggable={editing === undefined}
        ondragstart={(e) => {
          dragging = d.id
          e.dataTransfer?.setData('text/plain', d.id)
        }}
        ondragend={() => (dragging = undefined)}
        ondragover={(e) => e.preventDefault()}
        ondrop={(e) => {
          e.preventDefault()
          drop(i)
        }}
      >
        {#if editing === d.id}
          <form class="card" onsubmit={(e) => { e.preventDefault(); commit() }}>
            <input
              aria-label="Desktop name"
              maxlength="40"
              bind:value={draft}
              use:focusInput
              onblur={commit}
              onkeydown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  editing = undefined
                }
              }}
            />
          </form>
        {:else}
          <button type="button" class="card" onclick={() => workspace.show(d.id)} ondblclick={() => rename(d.id, d.name)}>
            <span class="name">{i + 1} · {d.name}</span>
            <span class="meta">{d.layout.toUpperCase()} · {d.windows.length} {d.windows.length === 1 ? 'WINDOW' : 'WINDOWS'}</span>
            <span class="list">
              {#each d.windows as w (w.id)}
                <span class:min={w.state === 'min'}>{appOf(w.app, workspace.apps)?.glyph ?? '□'} {w.title}</span>
              {:else}
                <span class="empty">Empty</span>
              {/each}
            </span>
          </button>
        {/if}
        <span class="tools">
          <button type="button" aria-label="Move {d.name} left" disabled={i === 0} onclick={() => workspace.moveDesktop(d.id, i - 1)}>◀</button>
          <button type="button" aria-label="Move {d.name} right" disabled={i === workspace.doc.desktops.length - 1} onclick={() => workspace.moveDesktop(d.id, i + 1)}>▶</button>
          <button type="button" aria-label="Rename {d.name}" onclick={() => rename(d.id, d.name)}>✎</button>
          {#if workspace.doc.desktops.length > 1}
            <button type="button" aria-label="Close {d.name}" onclick={() => workspace.removeDesktop(d.id)}>×</button>
          {/if}
        </span>
      </li>
    {/each}
    {#if workspace.doc.desktops.length < MAX_DESKTOPS}
      <li><button type="button" class="card add" onclick={() => workspace.addDesktop()}>+ NEW DESKTOP</button></li>
    {/if}
  </ul>
  <dl class="keys" aria-label="Keyboard shortcuts">
    {#each SHORTCUTS as s (s.keys)}<div><dt>{s.keys}</dt><dd>{s.does}</dd></div>{/each}
  </dl>
</section>

<style>
  .overview { height: 100%; overflow-y: auto; padding: 8px 0; box-sizing: border-box; font-family: var(--font-mono); color: var(--hud-text); }
  h2 { margin: 0 0 16px; font-size: 11px; font-weight: 600; letter-spacing: 0.24em; color: var(--hud-title); }
  h2 span { color: var(--hud-muted); margin-left: 8px; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
  li { position: relative; }
  li.dragging { opacity: 0.5; }
  .card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    min-height: 150px;
    padding: 14px 16px 40px;
    box-sizing: border-box;
    text-align: left;
    background: var(--hud-fill);
    border: 1px solid var(--hud-border);
    color: inherit;
    font: inherit;
    cursor: pointer;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }
  .card:hover, .card:focus-visible { border-color: var(--hud-muted); }
  .current .card { border-color: var(--hud-bracket); }
  .name { font-size: 12px; font-weight: 600; letter-spacing: 0.16em; color: var(--hud-title); }
  .meta { font-size: 9px; letter-spacing: 0.18em; color: var(--hud-muted); padding-bottom: 6px; border-bottom: 1px dashed var(--hud-rule); }
  .list { display: flex; flex-direction: column; gap: 2px; font-size: 11px; }
  .list .min, .empty { color: var(--hud-muted); }
  .add { align-items: center; justify-content: center; padding-bottom: 14px; font-size: 10px; letter-spacing: 0.2em; color: var(--hud-muted); border-style: dashed; }
  input {
    width: 100%;
    height: 32px;
    padding: 0 8px;
    box-sizing: border-box;
    background: none;
    border: 1px solid var(--hud-bracket);
    color: var(--hud-title);
    font: inherit;
    font-size: 12px;
    letter-spacing: 0.12em;
  }
  .tools { position: absolute; left: 8px; right: 8px; bottom: 6px; display: flex; gap: 2px; justify-content: flex-end; }
  .tools button {
    width: 28px;
    height: 28px;
    padding: 0;
    background: none;
    border: 1px solid transparent;
    color: var(--hud-muted);
    font: inherit;
    font-size: 10px;
    cursor: pointer;
  }
  .tools button:disabled { opacity: 0.3; cursor: default; }
  .tools button:not(:disabled):hover, .tools button:focus-visible { color: var(--hud-title); border-color: var(--hud-border); }
  .keys { margin: 24px 0 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 4px 16px; font-size: 10px; letter-spacing: 0.08em; }
  .keys div { display: flex; gap: 12px; }
  .keys dt { flex: none; width: 140px; color: var(--hud-title); }
  .keys dd { margin: 0; color: var(--hud-muted); }
</style>
