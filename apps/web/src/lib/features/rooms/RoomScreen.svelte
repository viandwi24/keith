<script lang="ts">
import { G } from '@keith/ui/tokens'
import { onMount, tick } from 'svelte'
import { Markdown } from '../chat/index.ts'
import { ConfirmButton } from '../confirm/index.ts'
import { appBase, session } from '../session/index.ts'
import { RoomController } from './room.svelte.ts'
import { inputOffText, placeholderOf, sendsRoomMessage } from './room-keys.ts'
import { inviteesOf } from './rooms-view.ts'

let { id }: { id: string } = $props()
const base = appBase()

const SYSTEM = new Set(['join', 'leave', 'remove', 'end', 'system', 'handoff'])
const DOT = {
  online: { glyph: G.dot, tone: 'success', word: 'online' },
  busy: { glyph: G.working, tone: 'warning', word: 'busy' },
  offline: { glyph: G.idle, tone: 'muted', word: 'offline' },
  unshared: { glyph: G.idle, tone: 'muted', word: 'presence not shared' },
} as const

let ctl = $state<RoomController | undefined>(undefined)
let invite = $state('')
let scroller = $state<HTMLDivElement | undefined>(undefined)

onMount(() => {
  const me = session.me?.personId
  if (me === undefined) return undefined
  const made = new RoomController(id, me)
  ctl = made
  made.start()
  return () => made.stop()
})

const room = $derived(ctl?.state)
const replying = $derived(room?.transcript.at(-1)?.keith === true)
const off = $derived(room === undefined ? undefined : inputOffText(room))
const live = $derived(room !== undefined && !room.ended && !room.left)

// follow new lines only while the reader is at the bottom
let stick = true
function onScroll(): void {
  if (scroller !== undefined)
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48
}
$effect(() => {
  room?.transcript.length
  if (stick) void tick().then(() => scroller?.scrollTo({ top: scroller.scrollHeight }))
})

const timeOf = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

function keydown(event: KeyboardEvent): void {
  if (!sendsRoomMessage(event)) return
  event.preventDefault()
  void ctl?.send()
}

async function inviteSubmit(event: Event): Promise<void> {
  event.preventDefault()
  const people = inviteesOf(invite)
  if (people.length === 0 || ctl === undefined) return
  await ctl.invite(people)
  invite = ''
}
</script>

<svelte:head><title>{room?.name ?? 'Room'} · Keith</title></svelte:head>

<section class="room">
  <a class="k-link-back" href="{base}/rooms">← Rooms</a>
  {#if room === undefined}
    {#if ctl?.error !== undefined}<p class="k-note error" role="alert">{ctl.error}</p>{:else}<p class="k-muted">Loading the room…</p>{/if}
  {:else}
    <header>
      <h1>{room.name}</h1>
      {#if room.ended}<span class="k-badge">ended</span>{:else if room.left}<span class="k-badge">left</span>{/if}
      <span class="spacer"></span>
      {#if live && ctl !== undefined}
        <ConfirmButton label="Leave" question="Leave this room?" yes="Yes, leave" onconfirm={() => ctl?.leave()} />
        {#if room.canControl}
          <ConfirmButton label="End room" question={`End the room "${room.name}"?`} yes="Yes, end it" danger onconfirm={() => ctl?.end()} />
        {/if}
      {/if}
    </header>

    <ul class="members" aria-label="Members">
      {#each room.members as m (m.id)}
        <li class="member" class:invited={m.status === 'invited'}>
          <span class="dot {DOT[m.dot].tone}" aria-hidden="true">{DOT[m.dot].glyph}</span>
          {m.name}{m.status === 'invited' ? ' (invited)' : ''}
          <span class="k-sr-only">{DOT[m.dot].word}</span>
          {#if live && room.canControl && m.id !== session.me?.personId && m.id !== 'keith' && m.status === 'active'}
            <ConfirmButton label="Remove" question={`Remove ${m.name}?`} yes="Yes, remove" danger onconfirm={() => ctl?.remove(m.name)} />
          {/if}
        </li>
      {/each}
    </ul>

    {#if ctl?.error !== undefined}<p class="k-note error" role="alert">{ctl.error}</p>{/if}

    <div class="transcript" bind:this={scroller} onscroll={onScroll} role="log" aria-live="polite" aria-label="Transcript">
      {#if room.transcript.length === 0}
        <p class="k-muted">No messages yet. Say something to the room.</p>
      {/if}
      {#each room.transcript as line (line.seq)}
        {#if SYSTEM.has(line.kind)}
          <p class="system">{G.sep} {line.body}</p>
        {:else}
          <div class="line" class:keith={line.keith}>
            <span class="who">{#if line.keith}<span aria-hidden="true">{G.keith}</span> {/if}{line.speaker ?? 'someone'}</span>
            <div class="body">
              {#if line.keith}<Markdown text={line.body} />{:else}<p>{line.body}</p>{/if}
              <time class="when" datetime={new Date(line.at).toISOString()}>{timeOf(line.at)}</time>
            </div>
          </div>
        {/if}
      {/each}
    </div>

    <p class="indicator" aria-live="polite">{room.indicator ?? ''}</p>

    {#if room.confirmation !== undefined}
      {@const ask = room.confirmation}
      <div class="confirm" role="group" aria-label="Confirm">
        <p class="question">{ask.question}</p>
        {#if ask.detail !== undefined}<p class="k-muted detail">{ask.detail}</p>{/if}
        <div class="buttons">
          <button type="button" class="k-button primary" disabled={ctl?.answering} onclick={() => ctl?.answer(ask.id, true)}>Yes</button>
          <button type="button" class="k-button" disabled={ctl?.answering} onclick={() => ctl?.answer(ask.id, false)}>No</button>
        </div>
      </div>
    {/if}

    {#if ctl?.note !== undefined}<p class="k-note error" role="alert">{ctl.note}</p>{/if}

    {#if off !== undefined}
      <p class="k-muted off">{off}</p>
    {:else if ctl !== undefined}
      <form class="composer" onsubmit={(e) => { e.preventDefault(); void ctl?.send() }}>
        <textarea class="k-input" rows="2" aria-label="Message the room" placeholder={placeholderOf(replying)} bind:value={ctl.draft} onkeydown={keydown}></textarea>
        <button type="submit" class="k-button primary" disabled={ctl.sending || ctl.draft.trim() === ''}>Send</button>
      </form>
    {/if}

    {#if live}
      <details class="more">
        <summary>Invite someone</summary>
        <form class="invite" onsubmit={inviteSubmit}>
          <label class="k-sr-only" for="room-invite">Usernames to invite</label>
          <input id="room-invite" class="k-input" type="text" placeholder="username" autocomplete="off" bind:value={invite} />
          <button type="submit" class="k-button" disabled={inviteesOf(invite).length === 0}>Invite</button>
        </form>
      </details>
    {/if}
  {/if}
</section>

<style>
  .room { display: flex; flex-direction: column; max-width: 52rem; height: 100%; margin: 0 auto; padding: 1rem 1rem 1rem; min-height: 0; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; }
  h1 { margin: 0; font-size: 1.3rem; font-weight: 600; overflow-wrap: anywhere; }
  .spacer { flex: 1; }
  .members { display: flex; flex-wrap: wrap; gap: 0.4rem 1.2rem; margin: 0.6rem 0; padding: 0; list-style: none; font-size: 0.92rem; }
  .member { display: inline-flex; align-items: center; gap: 0.4rem; }
  .member.invited { color: var(--k-text-muted); }
  .dot { font-family: var(--font-mono); }
  .dot.success { color: var(--k-success); }
  .dot.warning { color: var(--k-warning); }
  .dot.muted { color: var(--k-text-muted); }
  .transcript { flex: 1 1 auto; min-height: 8rem; overflow-y: auto; padding: 0.5rem 0.25rem; border-block: 1px solid var(--border); }
  .line { display: grid; grid-template-columns: 7.5rem minmax(0, 1fr); gap: 0.75rem; padding: 0.35rem 0; }
  .who { font-weight: 600; overflow-wrap: anywhere; }
  .keith .who { color: var(--k-accent); }
  .body { min-width: 0; overflow-wrap: anywhere; }
  .body p { margin: 0; white-space: pre-wrap; }
  .when { font-size: 0.72rem; color: var(--k-text-muted); }
  .system { margin: 0.3rem 0; font-size: 0.85rem; color: var(--k-text-muted); }
  .indicator { min-height: 1.4rem; margin: 0.4rem 0 0; font-size: 0.85rem; color: var(--k-text-muted); }
  .confirm { margin: 0.5rem 0; padding: 0.7rem 0.9rem; border: 1px solid var(--k-warning); border-radius: var(--radius); background: var(--surface); }
  .question { margin: 0; font-weight: 600; }
  .detail { margin: 0.2rem 0 0; overflow-wrap: anywhere; }
  .buttons { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .composer { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.5rem; align-items: end; margin-top: 0.5rem; }
  .composer textarea { resize: vertical; min-height: 3rem; }
  .off { margin: 0.5rem 0; }
  .more { margin-top: 0.6rem; font-size: 0.9rem; }
  .invite { display: flex; gap: 0.5rem; margin-top: 0.4rem; max-width: 24rem; }
  @media (max-width: 639px) { .line { grid-template-columns: 1fr; gap: 0; } }
</style>
