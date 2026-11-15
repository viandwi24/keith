<script lang="ts">
import { Dialog } from 'bits-ui'
import type { ActionFlow } from './action-flow.svelte.ts'
import FormFields from './FormFields.svelte'

let { flow }: { flow: ActionFlow } = $props()

const d = $derived(flow.dialog)
const open = $derived(d !== undefined && (d.kind === 'form' || d.kind === 'confirm'))
const busy = $derived(d !== undefined && (d.kind === 'form' || d.kind === 'confirm') && d.busy)

function submit(event: SubmitEvent): void {
  event.preventDefault()
  void flow.submit()
}
</script>

<Dialog.Root {open} onOpenChange={(next) => { if (!next) flow.cancel() }}>
  <Dialog.Portal>
    <Dialog.Overlay class="k-overlay" />
    <Dialog.Content class="k-dialog">
      {#if d?.kind === 'form'}
        <Dialog.Title class="k-dialog-title">{d.action.label}</Dialog.Title>
        <Dialog.Description class="k-dialog-body hint">{d.action.hint ?? 'Fill in the fields.'}</Dialog.Description>
        <form onsubmit={submit} novalidate>
          <FormFields
            fields={d.action.fields ?? []}
            values={d.values}
            onchange={(id, value) => flow.set(id, value)}
            disabled={d.busy}
            showErrors={flow.attempted}
            idPrefix={d.action.id}
          />
          {#if d.error !== undefined}<p class="k-error-text" role="alert">{d.error}</p>{/if}
          <div class="k-dialog-actions actions">
            <button type="button" class="k-button" disabled={busy} onclick={() => flow.cancel()}>Cancel</button>
            <button type="submit" class="k-button primary" disabled={busy}>{busy ? 'Working…' : d.action.label}</button>
          </div>
        </form>
      {:else if d?.kind === 'confirm'}
        {@const word = d.action.confirm?.type}
        <Dialog.Title class="k-dialog-title">{d.action.label}</Dialog.Title>
        <Dialog.Description class="k-dialog-body">{d.action.confirm?.text}</Dialog.Description>
        <form onsubmit={submit}>
          {#if word !== undefined}
            <div class="k-field">
              <label for="confirm-word">Type <strong class="word">{word}</strong> to confirm</label>
              <!-- svelte-ignore a11y_autofocus -->
              <input
                id="confirm-word"
                class="k-input"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                autofocus
                disabled={d.busy}
                value={d.typed}
                oninput={(e) => flow.type(e.currentTarget.value)}
              />
            </div>
          {/if}
          {#if d.error !== undefined}<p class="k-error-text" role="alert">{d.error}</p>{/if}
          <div class="k-dialog-actions actions">
            <button type="button" class="k-button" disabled={busy} onclick={() => flow.cancel()}>Cancel</button>
            <button
              type="submit"
              class="k-button danger"
              disabled={busy || (word !== undefined && d.typed !== word)}
            >
              {busy ? 'Working…' : d.action.label}
            </button>
          </div>
        </form>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  .actions { gap: 0.5rem; margin-top: 0.5rem; }
  :global(.k-dialog-body.hint) { color: var(--k-text-muted); margin-bottom: 1rem; }
  .word { font-family: var(--font-mono); }
  .k-button.danger { color: var(--k-bg); background: var(--k-danger); border-color: var(--k-danger); font-weight: 600; }
  .k-button.danger:disabled { opacity: 0.4; }
</style>
