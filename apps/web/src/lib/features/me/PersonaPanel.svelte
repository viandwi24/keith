<script lang="ts">
import { watchPersona } from '@keith/client/browser'
import {
  BUILTIN_PERSONA_TEMPLATE_IDS,
  type PersonaTemplate,
  type PersonaView,
} from '@keith/contracts'
import { onMount } from 'svelte'
import { getClient } from '../session/index.ts'
import { isStepUpCancelled, stepUp } from '../stepup/index.ts'
import { toasts } from '../toasts/index.ts'
import { personaRows, personaSummary, templateFailure } from './persona-view.ts'

let { owner }: { owner: boolean } = $props()

let view = $state.raw<PersonaView | undefined>(undefined)
let error = $state<string | undefined>(undefined)
let choice = $state<PersonaTemplate>('professional')
let busy = $state(false)

function read(): void {
  void getClient()
    .persona.get()
    .then(
      (next) => {
        view = next
        error = undefined
        if (next.templateId !== 'custom') choice = next.templateId
      },
      (e: unknown) => {
        error = e instanceof Error ? e.message : String(e)
      },
    )
}

onMount(() => {
  read()
  return watchPersona({ feed: getClient().feed(), refetch: read })
})

async function switchTemplate(): Promise<void> {
  if (busy) return
  busy = true
  try {
    const next = await stepUp.guard(() => getClient().persona.setTemplate({ templateId: choice }))
    view = next
    toasts.push(`Persona is now ${personaSummary(next)}.`, { level: 'success' })
  } catch (e) {
    if (isStepUpCancelled(e)) toasts.push('Not confirmed.', { level: 'info' })
    else toasts.push(templateFailure(e), { level: 'error' })
  } finally {
    busy = false
  }
}
</script>

{#if error !== undefined}
  <p class="k-note error" role="alert">{error}</p>
{:else if view === undefined}
  <p class="k-muted">Reading…</p>
{:else}
  <p class="summary"><strong>{personaSummary(view)}</strong></p>
  <dl>
    {#each personaRows(view) as [name, value]}<dt>{name}</dt><dd>{value}</dd>{/each}
  </dl>
  {#if owner}
    <div class="switch">
      <label for="persona-template">Template</label>
      <select id="persona-template" class="k-input" bind:value={choice}>
        {#each BUILTIN_PERSONA_TEMPLATE_IDS as id}<option value={id}>{id}</option>{/each}
      </select>
      <button type="button" class="k-button" disabled={busy || view.templateId === choice} onclick={switchTemplate}>{busy ? 'Switching…' : 'Switch template'}</button>
    </div>
    <p class="k-hint">Switching asks you to confirm it is you. Editing the fields is in Manage, Persona.</p>
  {/if}
{/if}

<style>
  .summary { margin: 0 0 0.75rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.35rem 1.25rem; margin: 0 0 1rem; font-size: 0.9rem; }
  dt { color: var(--k-text-muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .switch { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin-bottom: 0.4rem; }
  .switch label { font-size: 0.85rem; font-weight: 600; }
  .switch select { width: auto; min-width: 9rem; appearance: auto; }
</style>
