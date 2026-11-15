<script lang="ts">
// A button that asks before it acts: the first click shows the question with a confirm and a cancel button (no dialog, no
// timer, so it works with the keyboard and a screen reader: the group is labelled by the question).
let {
  label,
  question,
  yes,
  no = 'Cancel',
  busy = false,
  busyLabel = label,
  danger = false,
  onconfirm,
}: {
  label: string
  question: string
  yes: string
  no?: string
  busy?: boolean
  busyLabel?: string
  danger?: boolean
  onconfirm: () => void
} = $props()
let asking = $state(false)
</script>

{#if asking}
  <span class="ask" role="group" aria-label={question}>
    <span>{question}</span>
    <button type="button" class="k-button" class:danger disabled={busy} onclick={() => { asking = false; onconfirm() }}>{yes}</button>
    <button type="button" class="k-button" onclick={() => (asking = false)}>{no}</button>
  </span>
{:else}
  <button type="button" class="k-button" disabled={busy} onclick={() => (asking = true)}>{busy ? busyLabel : label}</button>
{/if}

<style>
  .ask { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; font-size: 0.9rem; }
  .danger { color: var(--k-danger); border-color: var(--k-danger); }
  button { padding: 0.3rem 0.75rem; font-size: 0.85rem; }
</style>
