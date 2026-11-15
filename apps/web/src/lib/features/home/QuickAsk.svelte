<script lang="ts">
import { frontChat } from '../chat/index.ts'
import { connection } from '../connection/index.ts'
import { appBase } from '../session/index.ts'

const base = appBase()
const ctl = $derived(frontChat.ctl)
const offline = $derived(
  connection.link.kind === 'disconnected' || connection.link.kind === 'logged-out',
)

function onkeydown(event: KeyboardEvent): void {
  // Enter sends (not while an input method is composing); Esc stops a running turn
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    ctl?.submit()
  } else if (event.key === 'Escape' && ctl?.busy) ctl.stopTurn()
}
</script>

{#if ctl}
  <form class="ask" onsubmit={(e) => { e.preventDefault(); ctl.submit() }}>
    <input
      class="k-input"
      type="text"
      placeholder={offline ? 'Not connected to the core' : 'Ask Keith…'}
      aria-label="Ask Keith"
      autocomplete="off"
      disabled={offline}
      bind:value={ctl.draft}
      {onkeydown}
    />
    {#if ctl.busy}
      <button type="button" class="k-button" onclick={() => ctl.stopTurn()}>Stop</button>
    {:else}
      <button type="submit" class="k-button" disabled={offline || ctl.draft.trim() === ''}>Send</button>
    {/if}
  </form>
  {#if ctl.toast}<p class="note {ctl.toast.level}" role="status">{ctl.toast.text}</p>{/if}
  {#if ctl.notice}
    <div class="note {ctl.notice.level}" role="status">{#each ctl.notice.rows as row}<div>{row}</div>{/each}</div>
  {/if}
  <a class="open" href="{base}/chat">Open chat</a>
{/if}

<style>
  .ask { display: flex; gap: 0.5rem; width: 100%; max-width: 36rem; }
  .note { margin: 0; font-size: 0.85rem; color: var(--k-text-muted); text-align: center; }
  .note.warning { color: var(--k-warning); }
  .note.error { color: var(--k-danger); }
  .open { font-size: 0.85rem; }
</style>
