<script lang="ts">
import { countsTextOf, runOutcomeOf, undoTextOf } from '@keith/app-model'
import type { DreamMode } from '@keith/contracts'
import { onMount } from 'svelte'
import { ConfirmButton } from '../confirm/index.ts'
import { appBase, getClient } from '../session/index.ts'
import { toasts } from '../toasts/index.ts'
import {
  dreamFailure,
  loadMemory,
  type MemoryData,
  MODE_CHOICES,
  memoryViewOf,
} from './memory-view.ts'

const base = appBase()
let data = $state.raw<MemoryData | undefined>(undefined)
let loadError = $state<string | undefined>(undefined)
let busy = $state(false)

const view = $derived(data === undefined ? undefined : memoryViewOf(data))

async function load(): Promise<void> {
  try {
    data = await loadMemory(getClient().dreaming)
    loadError = undefined
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e)
  }
}

onMount(() => {
  void load()
})

/** Run one dreaming call: a failure is a toast in plain words; the screen reads the status again after it. */
async function act(call: () => Promise<void>): Promise<void> {
  if (busy) return
  busy = true
  try {
    await call()
  } catch (e) {
    const { text, level } = dreamFailure(e)
    toasts.push(text, { level })
  } finally {
    busy = false
    await load()
  }
}

const setMode = (mode: DreamMode) =>
  act(async () => {
    const status = await getClient().dreaming.setMode({ mode })
    toasts.push(`Dreaming mode: ${status.mode}.`, { level: 'success' })
  })

const now = () =>
  act(async () => {
    const { text, level } = runOutcomeOf(await getClient().dreaming.runNow())
    toasts.push(text, { level })
  })

const apply = (runId: string) =>
  act(async () => {
    const done = await getClient().dreaming.apply({ runId })
    if (done.status !== 'applied') {
      const { text, level } = runOutcomeOf(done)
      toasts.push(text, { level })
    } else toasts.push(`Applied: ${countsTextOf(done)}.`, { level: 'success' })
  })

const undo = () =>
  act(async () => {
    const { text, level } = undoTextOf(await getClient().dreaming.undo())
    toasts.push(text, { level })
  })
</script>

<svelte:head><title>Memory · Keith</title></svelte:head>

<section class="k-page">
  <a class="k-link-back" href="{base}/me">← Me</a>
  <h1>Memory</h1>
  <p class="k-sub">Only your own memory. Dreaming reviews your recent conversations and tidies what Keith remembers.</p>

  {#if loadError !== undefined}
    <p class="k-note error" role="alert">{loadError}</p>
  {:else if view === undefined}
    <p class="k-muted">Reading…</p>
  {:else}
    <fieldset class="modes">
      <legend>Mode</legend>
      {#each MODE_CHOICES as m}
        <label class="mode"><input type="radio" name="mode" value={m.mode} checked={view.mode === m.mode} disabled={busy} onchange={() => setMode(m.mode)} />
          <span><strong>{m.label}</strong> <span class="k-hint">{m.hint}</span></span></label>
      {/each}
    </fieldset>

    <dl class="rows">
      <dt>Last run</dt><dd>{view.lastRun}</dd>
      {#if view.nextRun !== undefined}<dt>Next run</dt><dd>may start {view.nextRun}</dd>{/if}
    </dl>

    <div class="actions">
      <button type="button" class="k-button" disabled={busy || view.mode === 'off'} onclick={now}>Dream now</button>
      {#if view.canUndo}
        <ConfirmButton label="Undo last dream" question="Put back what the last dream changed?" yes="Yes, undo" {busy} onconfirm={undo} />
      {/if}
    </div>

    {#if view.plan !== undefined}
      {@const plan = view.plan}
      <h2>Staged plan</h2>
      <div class="plan">
        <p class="plan-head"><strong>{plan.counts}</strong> <span class="k-muted">{plan.expiry}</span></p>
        {#if plan.entries.length > 0}
          <ul>{#each plan.entries as entry}<li>{entry.replace(/^- /, '')}</li>{/each}</ul>
        {/if}
        <ConfirmButton label="Apply the plan" question="Write this plan to your memory?" yes="Yes, apply" {busy} onconfirm={() => apply(plan.runId)} />
      </div>
    {/if}

    <h2>{view.diaryTitle ?? 'Diary'}</h2>
    {#if view.diaryTitle === undefined}
      <p class="k-muted">No diary yet.</p>
    {:else}
      <div class="diary">{#each view.diaryLines as line}<p>{line}</p>{/each}</div>
    {/if}
  {/if}
</section>

<style>
  .modes { border: none; padding: 0; margin: 0 0 1rem; display: grid; gap: 0.4rem; }
  legend { font-size: 0.85rem; font-weight: 600; padding: 0; margin-bottom: 0.3rem; }
  .mode { display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.92rem; }
  .rows { display: grid; grid-template-columns: max-content 1fr; gap: 0.35rem 1.25rem; margin: 0 0 1rem; font-size: 0.9rem; }
  dt { color: var(--k-text-muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.6rem; }
  .plan { padding: 0.75rem 1rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
  .plan-head { margin: 0 0 0.5rem; }
  .plan ul { margin: 0 0 0.75rem; padding-left: 1.2rem; font-size: 0.9rem; }
  .diary { padding: 0.5rem 1rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); font-size: 0.9rem; }
  .diary p { margin: 0.35rem 0; overflow-wrap: anywhere; }
</style>
