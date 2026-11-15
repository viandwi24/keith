<script lang="ts">
import { onDestroy, untrack } from 'svelte'
import { endText, TIMEOUT_TEXT } from './end-text.ts'
import { type CellSize, cellOf, gridOf, PROBE } from './grid.ts'
import { releasesFocus, terminalBytesOf } from './key-map.ts'
import { isOver } from './phase.ts'
import { rowsOf } from './runs.ts'
import { ViewSession } from './view-session.svelte.ts'

let { viewId, label, back }: { viewId: string; label: string; back: string } = $props()

const session = new ViewSession()
let probe: HTMLElement | undefined = $state()
let grid: HTMLElement | undefined = $state()
let backLink: HTMLAnchorElement | undefined = $state()
let boxWidth = $state(0)
let boxHeight = $state(0)
let cell = $state<CellSize | undefined>()
let focused = $state(false)
let wasOpen = false

// the cell is measured in a hidden probe of the same font, again whenever the box changes (a font or zoom change moves it)
$effect(() => {
  void boxWidth
  void boxHeight
  if (probe !== undefined) cell = cellOf(probe.getBoundingClientRect())
})
const size = $derived(gridOf({ width: boxWidth, height: boxHeight }, cell))
$effect(() => {
  if (size !== undefined) untrack(() => session.sync(viewId, size))
})
// the view opens with the keyboard on it: the person came here to use it
$effect(() => {
  const open = session.state.phase === 'open'
  if (open && !wasOpen) grid?.focus()
  wasOpen = open
})
onDestroy(() => session.close())

const view = $derived(session.state)
const over = $derived(isOver(view))
const end = $derived(
  view.reason === undefined
    ? view.phase === 'timeout'
      ? TIMEOUT_TEXT
      : undefined
    : endText(view.reason),
)
const rows = $derived(rowsOf(view.frame))

function onkeydown(event: KeyboardEvent): void {
  const like = {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    isComposing: event.isComposing,
    altGraph: event.getModifierState('AltGraph'),
  }
  if (releasesFocus(like)) {
    event.preventDefault()
    backLink?.focus()
    return
  }
  if (over) return
  const bytes = terminalBytesOf(like)
  if (bytes === undefined) return
  event.preventDefault()
  session.sendKey(bytes)
}

function onpaste(event: ClipboardEvent): void {
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (over || text === '') return
  event.preventDefault()
  session.sendKey(text)
}
</script>

<div class="terminal">
  <div class="bar">
    <a bind:this={backLink} class="k-link-back" href={back}>← Apps</a>
    <strong>{label}</strong>
    <span class="k-muted hint">{focused ? 'Esc leaves the keyboard' : 'click the view to type'}</span>
  </div>

  <div class="box" bind:clientWidth={boxWidth} bind:clientHeight={boxHeight}>
    <span class="probe" bind:this={probe} aria-hidden="true">{PROBE}</span>
    {#if view.phase === 'connecting'}
      <p class="k-muted status" aria-live="polite">connecting…{view.slow ? ' still waiting: the link to the core may be slow' : ''}</p>
    {:else}
      <div
        bind:this={grid}
        class="grid"
        class:focused
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        tabindex="0"
        {onkeydown}
        {onpaste}
        onfocus={() => (focused = true)}
        onblur={() => (focused = false)}
      ><pre style:--cell-h={cell === undefined ? undefined : `${cell.height}px`}>{#each rows as row (row.key)}<span class="row">{#each row.spans as span}<span style={span.style}>{span.text}</span>{/each}</span>{/each}</pre></div>
    {/if}
  </div>

  {#if over && end !== undefined}
    <div class="k-note {end.warning ? 'warning' : ''}" role="status">
      {#each end.rows as line}<p>{line}</p>{/each}
      <div class="actions">
        {#if end.reopen}<button class="k-button" type="button" onclick={() => session.reopen()}>Open again</button>{/if}
        <a class="k-button" href={back}>Back to Apps</a>
      </div>
    </div>
  {/if}
</div>

<style>
  .terminal { display: flex; flex-direction: column; gap: 0.6rem; padding: 1rem; height: 100%; min-height: 0; }
  .bar { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.8rem; }
  .hint { margin-left: auto; font-size: 0.85rem; }
  .box { position: relative; flex: 1; min-height: 12rem; height: calc(100dvh - 14rem); overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); background: var(--k-bg); }
  .probe { position: absolute; visibility: hidden; white-space: pre; font: 0.9rem/1.25 var(--font-mono); pointer-events: none; }
  .status { margin: 0.6rem; }
  .grid { width: 100%; height: 100%; overflow: hidden; color: var(--k-text); outline: none; cursor: text; }
  pre { margin: 0; font: 0.9rem/1.25 var(--font-mono); white-space: pre; }
  .grid.focused { box-shadow: inset 0 0 0 2px var(--k-accent); }
  .row { display: block; height: var(--cell-h, 1.25em); }
  .actions { display: flex; gap: 0.6rem; margin-top: 0.5rem; }
  .actions a { text-decoration: none; }
  p { margin: 0; }
</style>
