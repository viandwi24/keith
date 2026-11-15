<script lang="ts">
import { isWaitingForOwner } from '@keith/app-model'
import { appBase } from '../session/index.ts'
import ApprovalCard from './ApprovalCard.svelte'
import { approvals } from './approvals.svelte.ts'

const base = appBase()
// only an old core's items keep a card in the chat (ADR-0036 §7): conversation requests are answered by typing
// (ConsentLine), the rest in the Inbox
// answerable items first; a member's owner-routed items show read only when nothing else waits
const answerable = $derived(approvals.legacy.filter((i) => !isWaitingForOwner(i)))
const shown = $derived(answerable.length > 0 ? answerable : approvals.legacy)
const current = $derived(shown[0])
</script>

{#if current !== undefined}
  <section class="bar" aria-label="Approvals">
    <ApprovalCard
      item={current}
      now={approvals.now}
      busy={approvals.busy.includes(current.id)}
      onapprove={() => approvals.approve(current)}
      ondeny={(reason) => approvals.deny(current, reason)}
      onapprovetask={() => approvals.approveForTask(current)}
    />
    {#if shown.length > 1}
      <p class="more"><a href={`${base}/inbox`}>{shown.length - 1} more waiting in the Inbox</a></p>
    {/if}
  </section>
{/if}

<style>
  .bar { max-width: 760px; width: 100%; margin: 0 auto; padding: 0 1rem; }
  .more { margin: 0 0 0.4rem; font-size: 0.85rem; }
  a { color: var(--k-accent); }
</style>
