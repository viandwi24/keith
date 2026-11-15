<script lang="ts">
import { ApprovalBar, ConsentLine } from '../approvals/index.ts'
import { connection } from '../connection/index.ts'
import Composer from './Composer.svelte'
import ConversationView from './ConversationView.svelte'
import { frontChat } from './front.svelte.ts'

// the controller lives with the app (front.svelte.ts): leaving this page does not stop a running turn
const ctl = $derived(frontChat.ctl)

const offline = $derived(
  connection.link.kind === 'disconnected' || connection.link.kind === 'logged-out',
)

function onkeydown(event: KeyboardEvent): void {
  // Esc stops a running turn from anywhere on the page, unless a dialog or menu is open
  if (event.key === 'Escape' && ctl?.busy && !event.defaultPrevented) ctl.stopTurn()
}
</script>

<svelte:head><title>Chat · Keith</title></svelte:head>
<svelte:window {onkeydown} />

{#if ctl}
  <div class="chat">
    <ConversationView
      items={ctl.shownItems}
      tasks={ctl.tasks}
      now={ctl.now}
      phase={ctl.phase}
      busy={ctl.busy}
      sends={ctl.sends}
      loaded={ctl.loaded}
      hasOlder={ctl.hasOlder}
      loadingOlder={ctl.loadingOlder}
      settled={ctl.settled}
      pending={ctl.pending}
      dreaming={ctl.dream.running}
      showStart={ctl.generation > 0 && !ctl.hasOlder}
      generation={ctl.generation}
      loadOlder={() => ctl.loadOlder()}
      loadFull={(id) => ctl.loadFull(id)}
      answer={(item, option) => ctl.answer(item, option)}
    />
    <div class="notices">
      {#if ctl.toast}<p class="note {ctl.toast.level}" role="status">{ctl.toast.text}</p>{/if}
      {#if ctl.notice}
        <div class="note {ctl.notice.level}" role="status">{#each ctl.notice.rows as row}<div>{row}</div>{/each}</div>
      {/if}
      {#if ctl.sessionState?.problem}
        <div class="note error" role="alert">
          <span>{ctl.sessionState.problem.message}</span>
          <button type="button" class="k-button" onclick={() => ctl.session?.retry()}>Retry</button>
          <button type="button" class="k-button" onclick={() => ctl.dismissProblem()}>Dismiss</button>
        </div>
      {/if}
      {#if ctl.interrupted && !ctl.storedInterrupted}
        <div class="note warning" role="status">
          <span>The previous turn was interrupted: its process stopped before it finished.</span>
        </div>
      {/if}
      {#if ctl.interrupted}
        <div class="actions">
          <button type="button" class="k-button primary" onclick={() => ctl.continueTurn()}>Continue</button>
          <button type="button" class="k-button" onclick={() => ctl.retryTurn()}>Retry</button>
        </div>
      {/if}
    </div>
    <ApprovalBar />
    <ConsentLine />
    <Composer
      bind:draft={ctl.draft}
      busy={ctl.busy}
      disabled={offline}
      disabledReason="Not connected to the core"
      submit={() => ctl.submit()}
      stop={() => ctl.stopTurn()}
    />
  </div>
{/if}

<style>
  .chat { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .notices { max-width: 760px; width: 100%; margin: 0 auto; padding: 0 1rem; }
  .note { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; margin: 0.4rem 0; padding: 0.5rem 0.8rem; font-size: 0.9rem; background: var(--surface); border-left: 3px solid var(--k-info); border-radius: 0 var(--radius) var(--radius) 0; }
  .note.warning { border-color: var(--k-warning); }
  .note.error { border-color: var(--k-danger); }
  .note div { width: 100%; }
  .actions { display: flex; gap: 0.5rem; margin: 0.4rem 0; }
</style>
