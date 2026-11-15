<script lang="ts">
import { Dialog } from 'bits-ui'
import type { ActionFlow } from './action-flow.svelte.ts'
import CopyField from './CopyField.svelte'

let { flow }: { flow: ActionFlow } = $props()

const note = $derived(flow.note)
</script>

<Dialog.Root open={note !== undefined} onOpenChange={(next) => { if (!next) flow.closeNote() }}>
  <Dialog.Portal>
    <Dialog.Overlay class="k-overlay" />
    <Dialog.Content class="k-dialog note">
      {#if note !== undefined}
        <Dialog.Title class="k-dialog-title">{note.title}</Dialog.Title>
        <Dialog.Description class="k-dialog-body desc">
          {note.once === true ? 'Shown this one time. Copy it now: it cannot be shown again.' : 'What the core says.'}
        </Dialog.Description>
        {#if note.once === true}
          <div class="secret">
            <output class="value" aria-label={note.title}>{note.lines[0] ?? ''}</output>
            <CopyField text={note.lines[0] ?? ''} label="Copy" />
          </div>
          {#each note.lines.slice(1) as line, at (at)}<p class="line">{line}</p>{/each}
        {:else}
          <div class="lines">{#each note.lines as line, at (at)}<div class="line">{line === '' ? ' ' : line}</div>{/each}</div>
        {/if}
        <div class="k-dialog-actions actions">
          <button type="button" class="k-button primary" onclick={() => flow.closeNote()}>
            {note.once === true ? 'I have copied it' : 'Close'}
          </button>
        </div>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.k-dialog.note) { width: min(38rem, calc(100vw - 2rem)); max-height: 85dvh; overflow-y: auto; }
  :global(.k-dialog-body.desc) { color: var(--k-text-muted); margin-bottom: 0.75rem; }
  .secret { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.75rem; }
  .value {
    flex: 1;
    min-width: 0;
    padding: 0.55rem 0.7rem;
    font-family: var(--font-mono);
    font-size: 0.9rem;
    overflow-wrap: anywhere;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    user-select: all;
  }
  .lines { font-family: var(--font-mono); font-size: 0.85rem; }
  .line { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 0.3rem; font-size: 0.9rem; }
  .lines .line { margin: 0; font-size: 0.85rem; }
  .actions { margin-top: 1rem; }
</style>
