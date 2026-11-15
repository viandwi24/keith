<script lang="ts">
import ApprovalCard from './ApprovalCard.svelte'
import { approvals } from './approvals.svelte.ts'
</script>

<svelte:head><title>Inbox · Keith</title></svelte:head>

<section class="inbox">
  <h1>Inbox</h1>
  {#if approvals.loadError !== undefined && approvals.items.length === 0}
    <p class="error" role="alert">{approvals.loadError}</p>
  {:else if !approvals.loaded}
    <p class="muted">Loading…</p>
  {:else if approvals.items.length === 0}
    <p class="muted">Nothing is waiting for you.</p>
  {:else}
    <h2>Approvals <span class="count">{approvals.items.length}</span></h2>
    {#each approvals.items as item (item.id)}
      <ApprovalCard
        {item}
        now={approvals.now}
        busy={approvals.busy.includes(item.id)}
        onapprove={() => approvals.approve(item)}
        ondeny={(reason) => approvals.deny(item, reason)}
        onapprovetask={() => approvals.approveForTask(item)}
      />
    {/each}
  {/if}
</section>

<style>
  .inbox { max-width: 760px; margin: 0 auto; padding: 1.5rem 1rem; }
  h1 { margin: 0 0 1rem; font-size: 1.4rem; font-weight: 600; }
  h2 { margin: 0 0 0.25rem; font-size: 1rem; font-weight: 600; }
  .count { color: var(--k-text-muted); font-weight: 400; }
  .muted { color: var(--k-text-muted); }
  .error { color: var(--k-danger); }
</style>
