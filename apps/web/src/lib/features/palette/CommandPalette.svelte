<script lang="ts">
import { Dialog } from 'bits-ui'
import { tick } from 'svelte'
import { live } from '../live/index.ts'
import { sectionsFor } from '../manage/index.ts'
import { notifications } from '../presence/index.ts'
import { session } from '../session/index.ts'
import { motion, NAV, rail } from '../shell/index.ts'
import {
  clampIndex,
  filterItems,
  groupsOf,
  moveIndex,
  opensPalette,
  type PaletteItem,
  paletteItems,
  paletteKeyAction,
} from './model.ts'
import { runAction } from './palette.svelte.ts'

let query = $state('')
let index = $state(0)
let field = $state<HTMLInputElement>()
let list = $state<HTMLElement>()

const items = $derived(
  paletteItems({
    nav: NAV.map((n) => ({ id: n.id, label: n.label, path: n.path })),
    sections: sectionsFor(session.me),
    budget: live.budget,
    notificationsLabel: notifications.label,
    stillOrb: motion.still,
  }),
)
const shown = $derived(filterItems(items, query))
const groups = $derived(groupsOf(shown))
const selected = $derived(clampIndex(index, shown.length))
const active = $derived(shown[selected])

// a new query starts at the top; opening starts fresh
$effect(() => {
  query
  index = 0
})
$effect(() => {
  if (!rail.paletteOpen) return
  query = ''
  index = 0
  void tick().then(() => field?.focus())
})
// keep the selected row in view
$effect(() => {
  const id = active?.id
  if (id === undefined) return
  list?.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
})

function run(item: PaletteItem | undefined): void {
  if (item === undefined) return
  rail.paletteOpen = false
  void runAction(item.action)
}

function onFieldKey(event: KeyboardEvent): void {
  const action = paletteKeyAction(event)
  if (action === undefined) return
  event.preventDefault()
  if (action.type === 'move') index = moveIndex(selected, action.delta, shown.length)
  else if (action.type === 'run') run(active)
  else rail.paletteOpen = false
}

// ⌘K or Ctrl+K from anywhere, a text field included; no other key opens it
function onWindowKey(event: KeyboardEvent): void {
  if (!opensPalette(event)) return
  event.preventDefault()
  rail.paletteOpen = !rail.paletteOpen
}
</script>

<svelte:window onkeydown={onWindowKey} />

<Dialog.Root bind:open={rail.paletteOpen}>
  <Dialog.Portal>
    <Dialog.Overlay class="k-overlay" />
    <Dialog.Content class="k-palette" aria-label="Command palette" onOpenAutoFocus={(e) => e.preventDefault()}>
      <Dialog.Title class="k-sr-only">Command palette</Dialog.Title>
      <Dialog.Description class="k-sr-only">Type to filter, arrow keys to move, Enter to run, Escape to close</Dialog.Description>
      <input
        bind:this={field}
        bind:value={query}
        class="field"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={active === undefined ? undefined : `palette-${active.id}`}
        aria-label="Search commands"
        placeholder="Go to, or do…"
        autocomplete="off"
        spellcheck="false"
        onkeydown={onFieldKey}
      />
      <div id="palette-list" class="list" role="listbox" aria-label="Commands" bind:this={list}>
        {#if shown.length === 0}
          <p class="none">Nothing matches “{query}”.</p>
        {/if}
        {#each groups as g (g.group + g.items[0]?.id)}
          <div class="group" role="group" aria-label={g.group}>
            <div class="heading" aria-hidden="true">{g.group}</div>
            {#each g.items as item (item.id)}
              <div
                id="palette-{item.id}"
                data-id={item.id}
                class="item"
                class:on={active?.id === item.id}
                role="option"
                tabindex="-1"
                aria-selected={active?.id === item.id}
                onpointermove={() => (index = shown.indexOf(item))}
                onclick={() => run(item)}
                onkeydown={() => undefined}
              >
                <span class="label">{item.label}</span>
                {#if item.hint}<span class="hint">{item.hint}</span>{/if}
              </div>
            {/each}
          </div>
        {/each}
      </div>
      <p class="keys"><kbd>↑↓</kbd> move <kbd>Enter</kbd> run <kbd>Esc</kbd> close</p>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.k-palette) {
    position: fixed;
    z-index: 41;
    top: 12vh;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    width: min(34rem, calc(100vw - 1.5rem));
    max-height: min(32rem, 76vh);
    background: var(--k-bg);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) * 2);
    overflow: hidden;
  }
  .field {
    font: inherit;
    padding: 0.85rem 1rem;
    color: var(--k-text);
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--border);
    outline: none;
  }
  .list { overflow-y: auto; padding: 0.4rem; }
  .heading { padding: 0.5rem 0.6rem 0.2rem; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--k-text-muted); }
  .item { display: flex; justify-content: space-between; gap: 1rem; padding: 0.5rem 0.6rem; border-radius: calc(var(--radius) - 2px); cursor: pointer; font-size: 0.92rem; }
  .item.on { background: var(--surface-strong); }
  .hint { color: var(--k-text-muted); font-family: var(--font-mono); font-size: 0.8rem; }
  .none { margin: 0; padding: 1rem; color: var(--k-text-muted); }
  .keys { margin: 0; padding: 0.5rem 1rem; font-size: 0.75rem; color: var(--k-text-muted); border-top: 1px solid var(--border); }
  kbd { font-family: var(--font-mono); padding: 0 0.3rem; border: 1px solid var(--border); border-radius: 0.25rem; }
  @media (max-width: 639px) {
    :global(.k-palette) { top: 4vh; }
  }
</style>
