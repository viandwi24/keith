<script lang="ts">
import { Dialog } from 'bits-ui'
import { stepUp } from './stepup.svelte.ts'

const prompt = $derived(stepUp.prompt)
let secret = $state('')
const label = $derived(prompt?.method === 'password' ? 'Password' : 'PIN')

// a new prompt, a switched tab or a failed attempt starts from an empty field
$effect(() => {
  prompt?.method
  prompt?.error
  secret = ''
})

function submit(event: SubmitEvent): void {
  event.preventDefault()
  if (secret !== '') stepUp.submit(secret)
}
</script>

<Dialog.Root open={prompt !== undefined} onOpenChange={(next) => { if (!next) stepUp.cancel() }}>
  <Dialog.Portal>
    <Dialog.Overlay class="k-overlay" />
    <Dialog.Content class="k-dialog stepup">
      <Dialog.Title class="k-dialog-title">Confirm it's you</Dialog.Title>
      <Dialog.Description class="k-dialog-body">This action needs a quick check.</Dialog.Description>
      {#if prompt !== undefined}
        {#if !prompt.deadEnd}
          <div class="tabs" role="tablist" aria-label="Confirm with">
            {#each ['pin', 'password'] as const as method}
              <button
                type="button"
                role="tab"
                class:active={prompt.method === method}
                aria-selected={prompt.method === method}
                disabled={prompt.busy}
                onclick={() => stepUp.setMethod(method)}
              >
                {method === 'pin' ? 'PIN' : 'Password'}
              </button>
            {/each}
          </div>
        {/if}
        {#if prompt.error !== undefined}
          <p class="error" role="alert">✕ {prompt.error}</p>
        {/if}
        {#if !prompt.deadEnd}
          <form onsubmit={submit}>
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="k-input"
              type="password"
              autocomplete="off"
              autofocus
              bind:value={secret}
              aria-label={label}
              aria-invalid={prompt.error !== undefined}
              placeholder={prompt.busy ? 'checking…' : `Enter your ${label.toLowerCase()}`}
              disabled={prompt.busy}
            />
            <div class="k-dialog-actions actions">
              <button type="button" class="k-button" onclick={() => stepUp.cancel()}>Cancel</button>
              <button type="submit" class="k-button primary" disabled={prompt.busy || secret === ''}>
                {prompt.busy ? 'Checking…' : 'Confirm'}
              </button>
            </div>
          </form>
        {:else}
          <div class="k-dialog-actions actions">
            <button type="button" class="k-button" onclick={() => stepUp.cancel()}>Close</button>
          </div>
        {/if}
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  .tabs { display: flex; gap: 0.25rem; margin-bottom: 0.75rem; padding: 0.2rem; background: var(--surface); border-radius: var(--radius); }
  .tabs button { flex: 1; padding: 0.4rem; font: inherit; color: var(--k-text-muted); background: none; border: none; border-radius: calc(var(--radius) - 2px); cursor: pointer; }
  .tabs button.active { color: var(--k-text); background: var(--surface-strong); }
  .error { margin: 0 0 0.75rem; color: var(--k-danger); overflow-wrap: anywhere; }
  .actions { gap: 0.5rem; margin-top: 1rem; }
  /* under 640 px the dialog is a sheet at the bottom edge */
  @media (max-width: 639px) {
    :global(.k-dialog.stepup) {
      top: auto;
      bottom: 0;
      left: 0;
      transform: none;
      width: 100%;
      border-radius: calc(var(--radius) * 2) calc(var(--radius) * 2) 0 0;
      padding-bottom: calc(1.5rem + env(safe-area-inset-bottom));
    }
  }
</style>
