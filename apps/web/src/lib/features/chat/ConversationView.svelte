<script lang="ts">
import type { ChatItem, Settled } from '@keith/app-model'
import {
  CONTEXT_PENDING_TEXT,
  type ContextKind,
  type DreamRunning,
  dreamingLineOf,
} from '@keith/app-model'
import type { Task } from '@keith/contracts'
import { tick, untrack } from 'svelte'
import MessageRows from './MessageRows.svelte'
import {
  isAtBottom,
  onNewContent,
  type ScrollMetrics,
  scrollTopAfterPrepend,
  shouldLoadOlder,
} from './scroll.ts'
import { type ChatPhase, PHASE_TEXT } from './status.ts'

let {
  items,
  tasks,
  now,
  phase,
  busy,
  sends,
  loaded,
  hasOlder,
  loadingOlder,
  settled,
  pending,
  dreaming,
  showStart,
  generation,
  loadOlder,
  loadFull,
  answer,
  readOnly = false,
}: {
  items: readonly ChatItem[]
  tasks: readonly Task[]
  now: number
  phase: ChatPhase
  busy: boolean
  sends: number
  loaded: boolean
  hasOlder: boolean
  loadingOlder: boolean
  settled: Readonly<Record<string, Settled>>
  pending: ContextKind | undefined
  dreaming: DreamRunning | undefined
  showStart: boolean
  generation: number
  loadOlder: () => Promise<number>
  loadFull: (messageId: string) => Promise<unknown>
  answer: (item: Extract<ChatItem, { kind: 'question' }>, option: string) => void
  readOnly?: boolean
} = $props()

let box = $state<HTMLDivElement>()
let stuck = true
let seenSends = 0
let showJump = $state(false)

const metrics = (): ScrollMetrics => ({
  scrollTop: box?.scrollTop ?? 0,
  clientHeight: box?.clientHeight ?? 0,
  scrollHeight: box?.scrollHeight ?? 0,
})

function toBottom(): void {
  if (box === undefined) return
  box.scrollTop = box.scrollHeight
  stuck = true
  showJump = false
}

async function onScroll(): Promise<void> {
  const m = metrics()
  stuck = isAtBottom(m)
  if (stuck) showJump = false
  if (shouldLoadOlder(m, { hasOlder, loadingOlder, loaded })) {
    const before = metrics()
    const added = await loadOlder()
    await tick()
    if (box !== undefined && added > 0)
      box.scrollTop = scrollTopAfterPrepend(before, box.scrollHeight)
  }
}

// new content: follow it from the bottom or after a send, else offer "jump to latest"
$effect(() => {
  items
  phase
  pending
  dreaming
  const justSent = sends !== untrack(() => seenSends)
  const wasAtBottom = untrack(() => stuck)
  untrack(() => {
    seenSends = sends
  })
  void tick().then(() => {
    if (onNewContent({ wasAtBottom, justSent }) === 'follow') toBottom()
    else showJump = true
  })
})

const last = $derived(items.filter((i) => i.kind !== 'divider').at(-1))
const streamingId = $derived(busy && last?.kind === 'assistant' ? last.id : undefined)
const openQuestionId = $derived.by(() => {
  const q = items.findLast((i) => i.kind === 'question')
  return q !== undefined && settled[q.id] === undefined ? q.id : undefined
})
</script>

<div class="wrap">
  <div class="scroll" bind:this={box} onscroll={onScroll} role="log" aria-live="polite" aria-label="Conversation">
    <div class="column">
      {#if loadingOlder}<p class="note">loading older messages…</p>{/if}
      {#if !loaded}
        <p class="note">loading…</p>
      {:else if items.length === 0 && !busy}
        <div class="empty">
          <p>Talk to Keith.</p>
          <p class="muted">It can run tasks in the background and act on your nodes. Type / for commands.</p>
        </div>
      {/if}
      {#if showStart}<div class="start" role="separator"><span>new context · conversation {generation + 1}</span></div>{/if}
      <MessageRows {items} {tasks} {now} {streamingId} {settled} {openQuestionId} {loadFull} {answer} />
      {#if !readOnly}
        {#if phase !== 'idle' && last?.kind !== 'assistant'}
          <p class="status"><span class="spin" aria-hidden="true"></span>{PHASE_TEXT[phase]}</p>
        {:else if phase === 'stalled'}
          <p class="status warn">{PHASE_TEXT.stalled}</p>
        {/if}
        {#if pending !== undefined}<p class="status"><span class="spin" aria-hidden="true"></span>{CONTEXT_PENDING_TEXT[pending]}</p>{/if}
        {#if dreaming !== undefined}<p class="status"><span class="spin" aria-hidden="true"></span>{dreamingLineOf(dreaming, now)}</p>{/if}
      {/if}
    </div>
  </div>
  {#if showJump}
    <button type="button" class="jump k-button" onclick={toBottom}>↓ Jump to latest</button>
  {/if}
</div>

<style>
  .wrap { position: relative; flex: 1; min-height: 0; display: flex; }
  .scroll { flex: 1; overflow-y: auto; overscroll-behavior: contain; }
  .column { max-width: 760px; margin: 0 auto; padding: 0.5rem 1rem 1rem; }
  .note, .muted { color: var(--k-text-muted); font-size: 0.9rem; }
  .empty { margin: 3rem 0; }
  .empty p { margin: 0.2rem 0; }
  .status { display: flex; align-items: center; gap: 0.5rem; margin: 0.75rem 0 0 1.65rem; color: var(--k-text-muted); font-size: 0.9rem; }
  .status.warn { color: var(--k-warning); }
  .spin { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--k-accent); animation: pulse 1s ease-in-out infinite; }
  .start { display: flex; align-items: center; gap: 0.75rem; margin: 0.75rem 0; font-size: 0.8rem; color: var(--k-text-muted); }
  .start::before, .start::after { content: ''; flex: 1; height: 1px; background: var(--border); }
  .jump { position: absolute; bottom: 0.75rem; left: 50%; transform: translateX(-50%); box-shadow: 0 2px 10px color-mix(in srgb, var(--k-bg) 60%, transparent); }
  @keyframes pulse { 50% { opacity: 0.3; } }
</style>
