<script lang="ts">
import { GUEST_BANNER } from '@keith/contracts'
import { onDestroy, onMount, tick } from 'svelte'
import { Markdown } from '#lib/features/chat/index.ts'
import { GuestChat } from './guest-chat.svelte.ts'
import { endsText, GUEST_EMPTY, isEmptyAnswer, leftText, WATCHED_TEXT } from './guest-state.ts'

const chat = new GuestChat()
let draft = $state('')
let now = $state(Date.now())
let list = $state<HTMLElement>()
let field = $state<HTMLTextAreaElement>()
let left = $state(false)

onMount(() => {
  void chat.open()
  const clock = setInterval(() => (now = Date.now()), 15_000)
  const bye = (): void => chat.dispose()
  window.addEventListener('pagehide', bye)
  return () => {
    clearInterval(clock)
    window.removeEventListener('pagehide', bye)
  }
})
onDestroy(() => chat.dispose())

const over = $derived(chat.phase === 'ended' || chat.phase === 'refused')
const visible = $derived(chat.items.filter((i) => !isEmptyAnswer(i)))
const thinking = $derived(chat.busy && visible.length < chat.items.length)
const info = $derived(
  [
    leftText(chat.turnsLeft, chat.session?.limits.maxTurns),
    chat.session === undefined ? '' : endsText(chat.session.expiresAt, now),
  ].filter((t) => t !== ''),
)

// follow new content only when the reader is near the bottom
$effect(() => {
  void chat.items
  void chat.busy
  const el = list
  if (el === undefined) return
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  if (near) void tick().then(() => el.scrollTo({ top: el.scrollHeight }))
})

function submit(): void {
  const text = draft
  if (text.trim() === '') return
  draft = ''
  chat.send(text)
  void tick().then(() => field?.focus())
}

function onkeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    submit()
  }
}

async function leave(): Promise<void> {
  await chat.leave()
  left = true
}
</script>

<svelte:head><title>Guest · Keith</title></svelte:head>

<main class="guest">
  <header>
    <h1><span aria-hidden="true">✳</span> Keith <span class="k-muted">guest</span></h1>
    {#if !left && chat.phase === 'ready'}
      <button class="k-button" type="button" onclick={leave}>End chat</button>
    {/if}
  </header>

  {#if left}
    <p class="k-note" role="status">This chat has ended. Nothing was kept.</p>
    <button class="k-button primary" type="button" onclick={() => location.reload()}>Start a new chat</button>
  {:else}
    <p class="k-note" role="note">{chat.session?.notice ?? GUEST_BANNER}</p>
    {#if chat.watched}<p class="k-note warning" role="status">{WATCHED_TEXT}</p>{/if}
    {#if info.length > 0}<p class="k-muted info">{info.join('  ·  ')}</p>{/if}

    <div class="messages" bind:this={list} aria-live="polite" aria-label="Conversation">
      {#if chat.phase === 'opening'}
        <p class="k-muted">starting a chat…</p>
      {:else if chat.phase === 'ready' && visible.length === 0}
        {#each GUEST_EMPTY as line}<p class="k-muted">{line}</p>{/each}
      {/if}
      {#each visible as item (item.id)}
        {#if item.kind === 'user'}
          <div class="row user"><p>{item.text}</p></div>
        {:else if item.kind === 'assistant'}
          <div class="row assistant">
            {#each item.blocks as block}
              {#if block.kind === 'text'}
                <Markdown text={block.text} />
              {:else}
                <p class="k-muted tool">{block.state === 'running' ? '…' : block.state === 'done' ? '✓' : '✕'} {block.name}</p>
              {/if}
            {/each}
          </div>
        {:else}
          <p class="k-note error" role="alert">{item.text}</p>
        {/if}
      {/each}
      {#if thinking}<p class="k-muted">thinking…</p>{/if}
    </div>

    {#if chat.endText !== undefined}
      <p class="k-note {chat.phase === 'ended' ? 'warning' : 'error'}" role="alert">{chat.endText}</p>
    {/if}
    {#if chat.problem !== undefined}<p class="k-note error" role="alert">{chat.problem}</p>{/if}

    {#if over}
      <div class="actions">
        {#if chat.phase === 'refused' && chat.retryable}
          <button class="k-button primary" type="button" onclick={() => void chat.open()}>Try again</button>
        {:else}
          <button class="k-button primary" type="button" onclick={() => location.reload()}>Start a new chat</button>
        {/if}
      </div>
    {:else}
      <form class="composer" onsubmit={(e) => { e.preventDefault(); submit() }}>
        <textarea
          bind:this={field}
          bind:value={draft}
          class="k-input"
          rows="2"
          aria-label="Message"
          placeholder="ask about the public notes"
          disabled={chat.phase !== 'ready'}
          {onkeydown}
        ></textarea>
        {#if chat.busy}
          <button class="k-button" type="button" onclick={() => chat.stop()}>Stop</button>
        {:else}
          <button class="k-button primary" type="submit" disabled={chat.phase !== 'ready' || draft.trim() === ''}>Send</button>
        {/if}
      </form>
    {/if}
  {/if}
</main>

<style>
  .guest { display: flex; flex-direction: column; gap: 0.75rem; max-width: 46rem; min-height: 100dvh; margin: 0 auto; padding: 1rem; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  h1 { margin: 0; font-size: 1.2rem; }
  .info { margin: 0; font-size: 0.9rem; }
  .messages { flex: 1; min-height: 12rem; overflow-y: auto; display: flex; flex-direction: column; gap: 0.75rem; }
  .messages p { margin: 0; }
  .row.user { align-self: flex-end; max-width: 85%; padding: 0.5rem 0.8rem; background: var(--k-user-message); border-radius: var(--radius); white-space: pre-wrap; overflow-wrap: anywhere; }
  .row.assistant { overflow-wrap: anywhere; }
  .tool { font-family: var(--font-mono); font-size: 0.85rem; }
  .composer { display: flex; gap: 0.6rem; align-items: flex-end; position: sticky; bottom: 0; padding-bottom: 0.5rem; background: var(--k-bg); }
  .composer textarea { resize: none; }
  .actions { display: flex; gap: 0.6rem; }
</style>
