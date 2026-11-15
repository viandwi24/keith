<script lang="ts">
import type { AttentionItem } from '@keith/client/browser'
import { cardKeyAction, cardOf, isTypingTarget } from './card.ts'
import { cardAnchor } from './consent-line.ts'

let {
  item,
  now,
  busy = false,
  onapprove,
  ondeny,
  onapprovetask,
}: {
  item: AttentionItem
  now: number
  busy?: boolean
  onapprove: () => void
  ondeny: (reason?: string) => void
  onapprovetask: () => void
} = $props()

const view = $derived(cardOf(item, now))
let reasonOpen = $state(false)
let reason = $state('')

// Single keys answer only when the card itself is the focused element: a text field (the composer, the
// reason field) keeps every key, as the TUI's bar takes keys only after Tab.
function onkeydown(event: KeyboardEvent): void {
  const action = cardKeyAction(event, {
    cardFocused: event.target === event.currentTarget,
    typing: isTypingTarget(event.target as HTMLElement | null),
    scopable: view.scopable,
    // a conversation request is answered by typing in the chat: its card has buttons, no single keys
    readOnly: view.waiting || busy || view.conversation,
  })
  if (action === 'none') return
  event.preventDefault()
  if (action === 'allow') onapprove()
  else if (action === 'deny') ondeny()
  else if (action === 'allow-task') onapprovetask()
  else reasonOpen = true
}

function sendDeny(event: SubmitEvent): void {
  event.preventDefault()
  const text = reason.trim()
  reasonOpen = false
  reason = ''
  ondeny(text === '' ? undefined : text)
}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<article id={cardAnchor(item.id)} class="card" class:warn={view.warn} tabindex="0" aria-label="Approval needed" aria-keyshortcuts={view.conversation ? undefined : "y n N a"} {onkeydown}>
  <p class="headline">{view.headline}</p>
  <p class="meta">
    <span class="tool">{view.tool}</span>
    {#if view.node !== undefined}<span>on {view.node}</span>{/if}
  </p>
  {#if view.command !== undefined}
    <pre class="chip"><span class="prompt" aria-hidden="true">$</span> {view.command}</pre>
  {/if}
  {#if view.actions !== undefined}
    <ul class="chip actions">{#each view.actions as action, i (`${i}:${action}`)}<li>{action}</li>{/each}</ul>
  {/if}
  {#if view.detail !== undefined}<pre class="chip">{view.detail}</pre>{/if}
  {#if view.task !== undefined}<p class="task">task  {view.task}</p>{/if}
  <p class="life" class:warn={view.warn}>
    {#if view.age !== undefined}{view.age}{/if}
    {#if view.expiry !== undefined}{view.age !== undefined ? ' · ' : ''}{view.expiry}{/if}
  </p>
  {#if view.waiting}
    <p class="waiting" role="status">◐ Waiting for the owner to approve</p>
  {:else if reasonOpen}
    <form class="reason" onsubmit={sendDeny}>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="k-input"
        bind:value={reason}
        placeholder="Reason (the model is told)"
        aria-label="Reason for denying"
        autofocus
        onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); reasonOpen = false; reason = '' } }}
      />
      <button type="submit" class="k-button" disabled={busy}>Deny</button>
      <button type="button" class="k-button" onclick={() => { reasonOpen = false; reason = '' }}>Cancel</button>
    </form>
  {:else}
    <div class="buttons">
      <button type="button" class="k-button primary" disabled={busy} onclick={onapprove}>Allow once</button>
      {#if view.scopable}
        <button type="button" class="k-button" disabled={busy} onclick={onapprovetask}>Allow for task</button>
      {/if}
      <button type="button" class="k-button" disabled={busy} onclick={() => ondeny()}>Deny</button>
      <button type="button" class="k-button" disabled={busy} onclick={() => (reasonOpen = true)}>Deny with reason</button>
    </div>
    {#if view.conversation}<p class="task">Keith also asked in the chat: typing yes or no there answers this.</p>{/if}
    {#if !view.conversation}
      <p class="keys">With this card focused: y allow · n deny · N deny with reason{view.scopable ? ' · a allow for task' : ''}</p>
    {/if}
  {/if}
</article>

<style>
  .card { margin: 0.5rem 0; padding: 0.8rem 1rem; background: var(--surface); border: 1px solid var(--k-warning); border-radius: var(--radius); outline: none; }
  .card:focus-visible { box-shadow: 0 0 0 2px var(--k-accent); }
  .headline { margin: 0 0 0.25rem; font-weight: 600; overflow-wrap: anywhere; }
  .meta { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 0 0 0.5rem; font-size: 0.85rem; color: var(--k-text-muted); }
  .tool { font-family: var(--font-mono); color: var(--k-accent); }
  .chip { margin: 0.35rem 0; padding: 0.5rem 0.7rem; font-family: var(--font-mono); font-size: 0.85rem; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--k-bg); border: 1px solid var(--border); border-radius: var(--radius); list-style: none; }
  .actions li { margin: 0; }
  .prompt { color: var(--k-text-muted); }
  .task, .life, .keys { margin: 0.35rem 0 0; font-size: 0.85rem; color: var(--k-text-muted); white-space: pre-wrap; }
  .life { font-variant-numeric: tabular-nums; }
  .life.warn { color: var(--k-warning); }
  .waiting { margin: 0.5rem 0 0; color: var(--k-warning); }
  .buttons, .reason { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.6rem; }
  .reason .k-input { flex: 1; min-width: 12rem; }
  .keys { display: none; }
  .card:focus .keys { display: block; }
  @media (max-width: 639px) { .buttons :global(.k-button) { flex: 1 1 45%; } }
</style>
