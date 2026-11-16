<script lang="ts">
import AppView from './AppView.svelte'
import { appOf } from './apps.ts'
import { darkTokenStyle } from './dark-tokens.ts'
import { findWindow } from './model.ts'
import { pageAt, pageOffset, phoneCards } from './phone.ts'
import { workspace } from './workspace.svelte.ts'

// The workspace on a phone (P40.4): the desktops are pages side by side, swiped with scroll snap; the page that comes to rest is
// the desktop shown. On the shown desktop each window is a full-screen card, one under the other (focused first); minimised windows
// are slim rows at the end. Other pages list their windows only, so a swipe never loads every app at once.

const tokens = darkTokenStyle()
let strip = $state<HTMLDivElement | undefined>()
let pageWidth = $state(0)
let settle: ReturnType<typeof setTimeout> | undefined
/** The page was placed once: the first placing jumps, later ones glide. */
let placed = false
/** The strip is moving because this component scrolled it, not the person: its rest is not a choice. */
let moving = false

const index = $derived(workspace.doc.desktops.findIndex((d) => d.id === workspace.desktop.id))

// the shown desktop changed elsewhere (a shortcut, Keith, another tab) or the pages first laid out: bring its page in
$effect(() => {
  const width = pageWidth
  const id = workspace.desktop.id
  const count = workspace.doc.desktops.length
  const el = strip
  if (el === undefined || width === 0 || count === 0) return
  const left = pageOffset(workspace.doc, id, width)
  // after the pages are drawn at this width
  requestAnimationFrame(() => {
    if (Math.abs(el.scrollLeft - left) <= 2) return
    moving = true
    el.scrollTo({ left, behavior: placed ? 'smooth' : 'instant' })
    placed = true
  })
})

function rested(): void {
  if (strip === undefined) return
  if (moving) {
    moving = false
    return
  }
  const at = pageAt(strip.scrollLeft, pageWidth, workspace.doc.desktops.length)
  const target = workspace.doc.desktops[at]
  if (target !== undefined && at !== index) workspace.show(target.id)
}

function onscroll(): void {
  clearTimeout(settle)
  settle = setTimeout(rested, 120)
}
</script>

<div class="phone">
  <div class="strip" bind:this={strip} bind:clientWidth={pageWidth} {onscroll} role="region" aria-label="Desktops, swipe to change">
    {#each workspace.doc.desktops as d, i (d.id)}
      <section class="page" aria-label={d.name} aria-current={i === index}>
        <h2>{d.name} <span>{i + 1}/{workspace.doc.desktops.length}</span></h2>
        {#if i === index}
          {#each phoneCards(d) as card (card.id)}
            {@const win = findWindow(workspace.doc, card.id)?.window}
            {#if win !== undefined}
              {#if card.min}
                <button type="button" class="slim" onclick={() => workspace.apply({ op: 'window.focus', id: win.id })}>
                  {appOf(win.app, workspace.apps)?.glyph ?? '□'} {win.title} <span>RESTORE</span>
                </button>
              {:else}
                <article class="card" aria-label={win.title}>
                  <header>
                    <span class="title">{appOf(win.app, workspace.apps)?.glyph ?? '□'} {win.title}</span>
                    <button type="button" aria-label="Minimise {win.title}" onclick={() => workspace.apply({ op: 'window.setState', id: win.id, state: 'min' })}>_</button>
                    <button type="button" aria-label="Close {win.title}" onclick={() => workspace.apply({ op: 'window.close', id: win.id })}>×</button>
                  </header>
                  <div class="body" style={tokens}><AppView app={win.app} params={win.params} windowId={win.id} /></div>
                </article>
              {/if}
            {/if}
          {:else}
            <p class="empty">{d.name} is empty. Open an app from the dock.</p>
          {/each}
        {:else}
          <ul class="names">
            {#each d.windows as w (w.id)}<li>{appOf(w.app, workspace.apps)?.glyph ?? '□'} {w.title}</li>{:else}<li>Empty</li>{/each}
          </ul>
        {/if}
      </section>
    {/each}
  </div>
  {#if workspace.doc.desktops.length > 1}
    <div class="dots" aria-hidden="true">
      {#each workspace.doc.desktops as d, i (d.id)}<span class:on={i === index}></span>{/each}
    </div>
  {/if}
</div>

<style>
  .phone { position: relative; height: 100%; display: flex; flex-direction: column; font-family: var(--font-mono); }
  .strip {
    flex: 1;
    min-height: 0;
    display: flex;
    overflow-x: auto;
    overflow-y: hidden;
    scroll-snap-type: x mandatory;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }
  .page {
    flex: 0 0 100%;
    scroll-snap-align: start;
    scroll-snap-stop: always;
    overflow-y: auto;
    scroll-snap-type: y proximity;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-sizing: border-box;
    padding: 0 2px 8px;
  }
  h2 { margin: 0; font-size: 11px; font-weight: 600; letter-spacing: 0.24em; color: var(--hud-title); }
  h2 span { color: var(--hud-muted); margin-left: 8px; }
  .card {
    flex: 0 0 calc(100% - 28px);
    scroll-snap-align: start;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--hud-fill);
    border: 1px solid var(--hud-border);
  }
  header { display: flex; align-items: center; gap: 4px; padding: 4px 4px 4px 10px; border-bottom: 1px solid var(--hud-border); }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; letter-spacing: 0.16em; color: var(--hud-title); }
  header button, .slim {
    height: 32px;
    min-width: 32px;
    background: none;
    border: 1px solid transparent;
    color: var(--hud-muted);
    font: inherit;
    cursor: pointer;
  }
  .body {
    --border: var(--k-border);
    --surface: color-mix(in srgb, var(--k-text) 4%, var(--k-bg));
    --surface-strong: color-mix(in srgb, var(--k-text) 9%, var(--k-bg));
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--k-bg);
    color: var(--k-text);
    font-family: var(--font-ui);
  }
  .slim {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    border-color: var(--hud-border);
    background: var(--hud-fill);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-align: left;
  }
  .slim span { margin-left: auto; font-size: 9px; }
  .names { list-style: none; margin: 0; padding: 12px; border: 1px dashed var(--hud-border); color: var(--hud-muted); font-size: 11px; display: flex; flex-direction: column; gap: 4px; }
  .empty { margin: auto 0; text-align: center; font-size: 11px; letter-spacing: 0.18em; color: var(--hud-muted); }
  .dots { display: flex; justify-content: center; gap: 6px; padding-top: 6px; }
  .dots span { width: 6px; height: 6px; border: 1px solid var(--hud-muted); }
  .dots span.on { background: var(--hud-title); border-color: var(--hud-title); }
</style>
