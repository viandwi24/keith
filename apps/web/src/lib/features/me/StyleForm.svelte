<script lang="ts">
import {
  BREVITY_CHOICES,
  checkAddress,
  FORMALITY_CHOICES,
  LANGUAGE_CHOICES,
  STYLE_FIELD_LABELS,
  type StyleDraft,
  styleDraftOf,
  stylePatchOf,
  TOPIC_CHOICES,
  toggleTopic,
} from '@keith/app-model'
import { PERSONA_GENTLE_TOPICS_MAX, type PersonStyle } from '@keith/contracts'
import { onMount } from 'svelte'
import { getClient } from '../session/index.ts'

const ADDRESS_MAX = 40
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

let saved = $state<PersonStyle | undefined>(undefined)
let draft = $state<StyleDraft | undefined>(undefined)
let loadError = $state<string | undefined>(undefined)
let note = $state<{ level: 'info' | 'error'; text: string } | undefined>(undefined)
let busy = $state(false)

onMount(() => {
  let alive = true
  getClient()
    .persona.style.get()
    .then(
      (style) => {
        if (!alive) return
        saved = style
        draft = styleDraftOf(style)
      },
      (e: unknown) => {
        if (alive) loadError = messageOf(e)
      },
    )
  return () => {
    alive = false
  }
})

const address = $derived(draft === undefined ? undefined : checkAddress(draft.address))
const plan = $derived(
  saved === undefined || draft === undefined ? undefined : stylePatchOf(saved, draft),
)
const dirty = $derived(plan?.patch !== undefined || (plan?.problems.length ?? 0) > 0)
const topicsFull = $derived((draft?.gentleTopics.length ?? 0) >= PERSONA_GENTLE_TOPICS_MAX)

const label = (choice: string): string =>
  choice === 'auto' ? 'auto (follows the message)' : choice

async function save(event: Event): Promise<void> {
  event.preventDefault()
  if (saved === undefined || draft === undefined || busy) return
  const { patch, problems } = stylePatchOf(saved, draft)
  const first = problems[0]
  if (first !== undefined) {
    note = { level: 'error', text: `${STYLE_FIELD_LABELS[first.field]}: ${first.message}` }
    return
  }
  if (patch === undefined) {
    note = { level: 'info', text: 'Nothing to save.' }
    return
  }
  busy = true
  try {
    const next = await getClient().persona.style.set({ patch })
    saved = next
    draft = styleDraftOf(next)
    note = { level: 'info', text: 'Saved.' }
  } catch (e) {
    note = { level: 'error', text: messageOf(e) }
  } finally {
    busy = false
  }
}
</script>

{#if loadError !== undefined}
  <p class="k-note error" role="alert">{loadError}</p>
{:else if draft === undefined}
  <p class="k-muted">Reading…</p>
{:else}
  <form onsubmit={save} oninput={() => (note = undefined)}>
    <p class="k-hint lead">Only your own style. It never changes what you may do.</p>

    <div class="k-field">
      <label for="style-address">{STYLE_FIELD_LABELS.address}</label>
      <input id="style-address" class="k-input" type="text" maxlength={ADDRESS_MAX} placeholder="(none: your profile name)"
        aria-invalid={address?.ok === false && draft.address !== ''} aria-describedby="style-address-err" bind:value={draft.address} />
      <span id="style-address-err" class="k-error-text">{address?.ok === false ? address.message : ''}</span>
    </div>

    <div class="grid">
      <div class="k-field">
        <label for="style-language">{STYLE_FIELD_LABELS.language}</label>
        <select id="style-language" class="k-input" bind:value={draft.language}>
          {#each LANGUAGE_CHOICES as choice}<option value={choice}>{label(choice)}</option>{/each}
        </select>
      </div>
      <div class="k-field">
        <label for="style-brevity">{STYLE_FIELD_LABELS.brevity}</label>
        <select id="style-brevity" class="k-input" bind:value={draft.brevity}>
          {#each BREVITY_CHOICES as choice}<option value={choice}>{choice}</option>{/each}
        </select>
      </div>
      <div class="k-field">
        <label for="style-formality">{STYLE_FIELD_LABELS.formality}</label>
        <select id="style-formality" class="k-input" bind:value={draft.formality}>
          {#each FORMALITY_CHOICES as choice}<option value={choice}>{choice}</option>{/each}
        </select>
      </div>
    </div>

    <fieldset class="k-field">
      <legend>{STYLE_FIELD_LABELS.gentleTopics} <span class="k-hint">(up to {PERSONA_GENTLE_TOPICS_MAX}, treated gently)</span></legend>
      <div class="topics">
        {#each TOPIC_CHOICES as topic}
          {@const on = draft.gentleTopics.includes(topic)}
          <label class="topic"><input type="checkbox" checked={on} disabled={!on && topicsFull}
            onchange={() => { if (draft !== undefined) draft = toggleTopic(draft, topic) }} /> {topic}</label>
        {/each}
      </div>
    </fieldset>

    {#if note !== undefined}<p class="note {note.level}" role={note.level === 'error' ? 'alert' : 'status'}>{note.text}</p>{/if}
    <button type="submit" class="k-button primary" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</button>
  </form>
{/if}

<style>
  .lead { margin: 0 0 1rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: 0 1rem; }
  select { appearance: auto; }
  fieldset { border: none; padding: 0; margin: 0 0 1rem; min-width: 0; }
  legend { font-size: 0.85rem; font-weight: 600; padding: 0; margin-bottom: 0.4rem; }
  .topics { display: flex; flex-wrap: wrap; gap: 0.4rem 1.1rem; }
  .topic { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.92rem; font-weight: 400; }
  .note { margin: 0 0 0.75rem; font-size: 0.9rem; color: var(--k-text-muted); }
  .note.error { color: var(--k-danger); }
</style>
