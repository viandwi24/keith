<script lang="ts">
import { Dialog } from 'bits-ui'
import { privacy } from './privacy.svelte.ts'

const open = $derived(privacy.text !== undefined)
</script>

<Dialog.Root {open} onOpenChange={(next) => { if (!next) privacy.ack() }}>
  <Dialog.Portal>
    <Dialog.Overlay class="k-overlay" />
    <Dialog.Content class="k-dialog">
      <Dialog.Title class="k-dialog-title">Your privacy</Dialog.Title>
      <Dialog.Description class="k-dialog-body">{privacy.text}</Dialog.Description>
      <div class="k-dialog-actions">
        <button type="button" class="k-button primary" onclick={() => privacy.ack()}>Got it</button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
