<script lang="ts">
import { BUSY_NOTE_MAX } from '@keith/app-model'
import { toasts } from '../toasts/index.ts'
import { presenceMine } from './mine.svelte.ts'
import { CLEAR_STATUS, DURATIONS, initialDraft, KIND_LABEL, statusSetOf } from './status-form.ts'

let { stated }: { stated: boolean } = $props()

let draft = $state(initialDraft(Date.now()))
let problem = $state<string | undefined>(undefined)
const presetMinutes = $derived(DURATIONS.some((d) => String(d.minutes) === draft.minutes))

async function save(event: Event): Promise<void> {
  event.preventDefault()
  const result = statusSetOf(draft, Date.now())
  if (!result.ok) {
    problem = result.reason
    return
  }
  problem = undefined
  try {
    await presenceMine.setStatus(result.value)
    toasts.push(draft.kind === 'out' ? 'You are out.' : 'You are busy.', { level: 'success' })
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e)
  }
}

async function clear(): Promise<void> {
  problem = undefined
  try {
    await presenceMine.setStatus(CLEAR_STATUS)
    toasts.push('You are free.', { level: 'success' })
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e)
  }
}
</script>

<form onsubmit={save}>
  <fieldset class="k-field">
    <legend>Status</legend>
    {#each ['busy', 'out'] as const as kind}
      <label class="radio"><input type="radio" name="kind" value={kind} bind:group={draft.kind} /> {KIND_LABEL[kind]}</label>
    {/each}
  </fieldset>

  <div class="k-field">
    <label for="status-note">Note <span class="k-hint">({draft.note.length}/{BUSY_NOTE_MAX})</span></label>
    <input id="status-note" class="k-input" type="text" maxlength={BUSY_NOTE_MAX} placeholder="in a meeting" bind:value={draft.note} />
  </div>

  <fieldset class="k-field">
    <legend>Starts</legend>
    <label class="radio"><input type="radio" name="start" value="now" bind:group={draft.start} /> Now</label>
    <label class="radio"><input type="radio" name="start" value="at" bind:group={draft.start} /> At a time</label>
    {#if draft.start === 'at'}
      <input class="k-input narrow" type="datetime-local" aria-label="Start time" bind:value={draft.startAt} />
    {/if}
  </fieldset>

  <fieldset class="k-field">
    <legend>Ends</legend>
    <label class="radio"><input type="radio" name="end" value="after" bind:group={draft.end} /> After a while</label>
    {#if draft.end === 'after'}
      <select class="k-input narrow" aria-label="Duration" value={presetMinutes ? draft.minutes : '30'} onchange={(e) => (draft.minutes = e.currentTarget.value)}>
        {#each DURATIONS as d}<option value={String(d.minutes)}>{d.label}</option>{/each}
      </select>
    {/if}
    <label class="radio"><input type="radio" name="end" value="at" bind:group={draft.end} /> At a time</label>
    {#if draft.end === 'at'}
      <input class="k-input narrow" type="datetime-local" aria-label="End time" bind:value={draft.endAt} />
    {/if}
    <label class="radio"><input type="radio" name="end" value="open" bind:group={draft.end} /> No end (clears itself after a day)</label>
  </fieldset>

  {#if problem !== undefined}<p class="k-error-text" role="alert">{problem}</p>{/if}

  <div class="actions">
    <button type="submit" class="k-button primary" disabled={presenceMine.busy}>Set status</button>
    {#if stated}<button type="button" class="k-button" disabled={presenceMine.busy} onclick={clear}>Clear (I am free)</button>{/if}
  </div>
</form>

<style>
  fieldset { border: none; padding: 0; margin: 0 0 0.9rem; min-width: 0; }
  .radio { display: flex; align-items: center; gap: 0.5rem; font-size: 0.92rem; font-weight: 400; }
  .narrow { max-width: 16rem; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .k-field select { appearance: auto; }
</style>
