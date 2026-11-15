<script lang="ts">
import type { ActionSpec, Row } from '@keith/app-model/manage'
import { Dialog } from 'bits-ui'

let {
  row,
  header,
  onclose,
  onaction,
}: {
  row: Row | undefined
  header: readonly string[]
  onclose: () => void
  onaction: (action: ActionSpec) => void
} = $props()

const title = $derived(row?.cells[0] ?? '')
</script>

<Dialog.Root open={row !== undefined} onOpenChange={(next) => { if (!next) onclose() }}>
  <Dialog.Portal>
    <Dialog.Overlay class="k-overlay" />
    <Dialog.Content class="k-drawer manage-drawer">
      {#if row !== undefined}
        <div class="inner">
          <Dialog.Title class="title">{title}</Dialog.Title>
          <Dialog.Description class="k-sr-only">Details and actions for {title}</Dialog.Description>
          <dl>
            {#each row.cells.slice(1) as cell, at (at)}
              <div>
                <dt>{header[at + 1] ?? ''}</dt>
                <dd class={row.tone ?? ''}>{cell === '' ? '-' : cell}</dd>
              </div>
            {/each}
          </dl>
          {#if row.detail !== undefined}<p class="detail">{row.detail}</p>{/if}
          {#if row.actions.length > 0}
            <h3>Actions</h3>
            <ul class="actions">
              {#each row.actions as action (action.id)}
                <li>
                  <button type="button" class="k-button act" onclick={() => onaction(action)}>
                    <span>{action.label}</span>
                    {#if action.hint !== undefined}<span class="hint">{action.hint}</span>{/if}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
          <button type="button" class="k-button close" onclick={onclose}>Close</button>
        </div>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.manage-drawer) { width: min(28rem, 100vw); }
  .inner { padding: 1.25rem; display: grid; gap: 0.5rem; }
  :global(.manage-drawer .title) { margin: 0 0 0.5rem; font-size: 1.15rem; font-weight: 600; overflow-wrap: anywhere; }
  dl { margin: 0; display: grid; gap: 0.5rem; }
  dl > div { display: grid; grid-template-columns: 7rem minmax(0, 1fr); gap: 0.5rem; }
  dt { font-size: 0.72rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--k-text-muted); padding-top: 0.15rem; }
  dd { margin: 0; overflow-wrap: anywhere; }
  dd.muted { color: var(--k-text-muted); }
  dd.warning { color: var(--k-warning); }
  dd.danger { color: var(--k-danger); }
  .detail { margin: 0.5rem 0 0; color: var(--k-text-muted); font-size: 0.9rem; overflow-wrap: anywhere; }
  h3 { margin: 1rem 0 0.25rem; font-size: 0.8rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--k-text-muted); font-weight: 600; }
  .actions { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; }
  .act { width: 100%; display: flex; justify-content: space-between; gap: 0.75rem; text-align: left; }
  .hint { color: var(--k-text-muted); font-size: 0.8rem; text-align: right; }
  .close { margin-top: 1rem; justify-self: start; }
</style>
