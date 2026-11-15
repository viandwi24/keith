<script lang="ts">
import {
  type FieldSpec,
  missingSetting,
  providerFieldSpecs,
  providerSettings,
} from '@keith/app-model/manage'
import type { ProviderDescription } from '@keith/contracts'
import { Dialog } from 'bits-ui'
import { getClient } from '../session/index.ts'
import { isStepUpCancelled, stepUp } from '../stepup/index.ts'
import { toasts } from '../toasts/index.ts'
import FormFields from './FormFields.svelte'

let { open = $bindable(false), ondone }: { open: boolean; ondone: () => void } = $props()

const CONNECTION_ID = /^[a-z0-9][a-z0-9-]*$/
const initialOf = (f: FieldSpec): string => f.initial ?? f.options?.[0] ?? ''

let described = $state.raw<ProviderDescription[]>([])
let loadError = $state<string | undefined>(undefined)
let providerId = $state('')
let values = $state<Record<string, string>>({})
let busy = $state(false)
let error = $state<string | undefined>(undefined)
let attempted = $state(false)

const desc = $derived(described.find((d) => d.id === providerId))
const settingSpecs = $derived(desc === undefined ? [] : providerFieldSpecs(desc))
const fields = $derived<FieldSpec[]>([
  { id: 'provider', label: 'Provider', options: described.map((d) => d.id) },
  ...settingSpecs,
  {
    id: 'conn:id',
    label: 'Connection id',
    optional: true,
    placeholder: 'defaults to the provider',
  },
  { id: 'conn:label', label: 'Label', optional: true },
])

function choose(id: string): void {
  providerId = id
  const next = described.find((d) => d.id === id)
  values = {
    provider: id,
    ...Object.fromEntries(
      (next === undefined ? [] : providerFieldSpecs(next)).map((f) => [f.id, initialOf(f)]),
    ),
  }
  error = undefined
}

function change(id: string, value: string): void {
  if (id === 'provider') choose(value)
  else values = { ...values, [id]: value }
  error = undefined
}

// opening reads what the core offers; closing drops everything typed, the key included
$effect(() => {
  if (!open) {
    values = {}
    providerId = ''
    error = undefined
    attempted = false
    busy = false
    return
  }
  loadError = undefined
  void getClient()
    .rpc.providers.describe()
    .then(
      (all) => {
        described = all
        if (all[0] !== undefined) choose(all[0].id)
      },
      (e: unknown) => {
        loadError = e instanceof Error ? e.message : String(e)
      },
    )
})

async function submit(event: SubmitEvent): Promise<void> {
  event.preventDefault()
  const d = desc
  if (d === undefined || busy) return
  attempted = true
  const missing = missingSetting(d, values)
  if (missing !== undefined) {
    error = missing
    return
  }
  const id = (values['conn:id'] ?? '').trim()
  if (id !== '' && !CONNECTION_ID.test(id)) {
    error = 'The connection id is lowercase letters, digits and dashes'
    return
  }
  let settings: Record<string, unknown>
  try {
    settings = providerSettings(d, values)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
    return
  }
  const label = (values['conn:label'] ?? '').trim()
  busy = true
  // the secrets leave the form's state now; the call keeps its own copy until it settles
  const secret = new Set(settingSpecs.filter((f) => f.secret === true).map((f) => f.id))
  values = Object.fromEntries(Object.entries(values).filter(([k]) => !secret.has(k)))
  try {
    const client = getClient()
    const saved = await stepUp.guard(() =>
      client.rpc.providers.put({
        providerId: d.id,
        ...(id === '' ? {} : { id }),
        ...(label === '' ? {} : { label }),
        settings,
      }),
    )
    const test = await client.rpc.providers.test({ id: saved.id })
    toasts.push(
      `${saved.id}: saved; ${test.ok ? 'connection works' : `connection test failed (${test.message ?? 'no answer'})`}`,
      { level: test.ok ? 'success' : 'warning' },
    )
    open = false
    ondone()
  } catch (e) {
    error = isStepUpCancelled(e) ? 'Not confirmed.' : e instanceof Error ? e.message : String(e)
    busy = false
  }
}
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="k-overlay" />
    <Dialog.Content class="k-dialog provider">
      <Dialog.Title class="k-dialog-title">Add a connection</Dialog.Title>
      <Dialog.Description class="k-dialog-body desc">The fields come from the provider. The key is sent once and never kept here.</Dialog.Description>
      {#if loadError !== undefined}
        <p class="k-error-text" role="alert">{loadError}</p>
      {:else if described.length === 0}
        <p class="k-muted">Reading the providers…</p>
      {:else}
        <form onsubmit={submit} novalidate>
          <FormFields {fields} {values} onchange={change} disabled={busy} showErrors={attempted} idPrefix="provider" />
          {#if desc?.doc !== undefined}<p class="k-hint">{desc.doc}</p>{/if}
          {#if error !== undefined}<p class="k-error-text" role="alert">{error}</p>{/if}
          <div class="k-dialog-actions actions">
            <button type="button" class="k-button" disabled={busy} onclick={() => (open = false)}>Cancel</button>
            <button type="submit" class="k-button primary" disabled={busy}>{busy ? 'Working…' : 'Save and test'}</button>
          </div>
        </form>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.k-dialog.provider) { max-height: 90dvh; overflow-y: auto; }
  :global(.k-dialog-body.desc) { color: var(--k-text-muted); margin-bottom: 1rem; }
  .actions { gap: 0.5rem; margin-top: 0.75rem; }
</style>
