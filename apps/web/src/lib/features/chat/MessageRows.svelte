<script lang="ts">
import { type ChatItem, type Settled, type ToolCall } from '@keith/app-model'
import type { Task } from '@keith/contracts'
import Markdown from './Markdown.svelte'
import QuestionCard from './QuestionCard.svelte'
import ToolCard from './ToolCard.svelte'

let {
  items,
  tasks,
  now,
  streamingId,
  settled,
  openQuestionId,
  loadFull,
  answer,
}: {
  items: readonly ChatItem[]
  tasks: readonly Task[]
  now: number
  /** The assistant message that streams now. */
  streamingId: string | undefined
  settled: Readonly<Record<string, Settled>>
  openQuestionId: string | undefined
  loadFull: (messageId: string) => Promise<unknown>
  answer: (item: Extract<ChatItem, { kind: 'question' }>, option: string) => void
} = $props()

const LEVEL_GLYPH = { info: '·', warning: '!', error: '✕' } as const
</script>

{#each items as item (item.id)}
  {#if item.kind === 'user'}
    <div class="row user"><div class="bubble">{item.text}</div></div>
  {:else if item.kind === 'assistant'}
    <div class="row assistant" class:streaming={item.id === streamingId}>
      <span class="dot" class:proactive={item.proactive} aria-hidden="true">{item.proactive ? '◆' : '●'}</span>
      <div class="content">
        {#each item.blocks as block}
          {#if block.kind === 'text'}
            <Markdown text={block.text} />
          {:else}
            <ToolCard call={block.call as ToolCall} {tasks} {now} loadFull={() => loadFull(item.id)} />
          {/if}
        {/each}
        {#if item.stopped}<p class="stopped">■ stopped</p>{/if}
      </div>
    </div>
  {:else if item.kind === 'notice'}
    <div class="row notice {item.level}" role={item.level === 'error' ? 'alert' : 'status'}>
      <span aria-hidden="true">{LEVEL_GLYPH[item.level]}</span><span>{item.text}</span>
    </div>
  {:else if item.kind === 'divider'}
    <div class="divider" role="separator"><span>{item.text}</span></div>
  {:else if item.kind === 'question'}
    <QuestionCard
      {item}
      settled={settled[item.id]}
      open={openQuestionId === item.id}
      answer={(option) => answer(item, option)}
    />
  {/if}
{/each}

<style>
  .row { margin: 1rem 0; }
  .user { display: flex; justify-content: flex-end; }
  .bubble { max-width: 85%; padding: 0.55rem 0.9rem; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface-strong); border: 1px solid var(--border); border-radius: calc(var(--radius) * 2); border-bottom-right-radius: 0.2rem; }
  .assistant { display: grid; grid-template-columns: 1.25rem minmax(0, 1fr); gap: 0.4rem; }
  .dot { color: var(--k-assistant-message); font-size: 0.8rem; line-height: 1.9; }
  .dot.proactive { color: var(--k-accent); }
  .streaming .dot { animation: pulse 1s ease-in-out infinite; }
  .stopped { margin: 0.4rem 0 0; font-size: 0.85rem; color: var(--k-text-muted); }
  .notice { display: flex; gap: 0.6rem; padding: 0.5rem 0.8rem; font-size: 0.9rem; background: var(--surface); border-left: 3px solid var(--k-info); border-radius: 0 var(--radius) var(--radius) 0; }
  .notice.warning { border-color: var(--k-warning); }
  .notice.error { border-color: var(--k-danger); }
  .divider { display: flex; align-items: center; gap: 0.75rem; margin: 1.25rem 0; font-size: 0.8rem; color: var(--k-text-muted); }
  .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: var(--border); }
  @keyframes pulse { 50% { opacity: 0.3; } }
</style>
