<script lang="ts">
import type { QuestionItem, Settled } from '@keith/app-model'

let {
  item,
  settled,
  open,
  answer,
}: {
  item: QuestionItem
  settled: Settled | undefined
  /** This is the newest question: it takes an answer. */
  open: boolean
  answer: (option: string) => void
} = $props()
let free = $state('')
</script>

<section class="question" aria-label="Question">
  <p class="text">{item.text}</p>
  {#if settled?.kind === 'answered'}
    <p class="done">answered: {settled.option}</p>
  {:else if settled?.kind === 'closed'}
    <p class="done">question closed</p>
  {:else if open}
    <div class="options">
      {#each item.options as option}
        <button type="button" class="k-button" onclick={() => answer(option)}>{option}</button>
      {/each}
    </div>
    <form onsubmit={(e) => { e.preventDefault(); const v = free.trim(); if (v !== '') { answer(v); free = '' } }}>
      <input class="k-input" bind:value={free} placeholder="Or type an answer" aria-label="Answer" />
      <button type="submit" class="k-button primary" disabled={free.trim() === ''}>Answer</button>
    </form>
  {/if}
</section>

<style>
  .question { margin: 0.75rem 0; padding: 0.8rem 1rem; background: var(--surface); border: 1px solid var(--k-accent); border-radius: var(--radius); }
  .text { margin: 0 0 0.6rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  .done { margin: 0; color: var(--k-text-muted); font-size: 0.9rem; }
  .options { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.6rem; }
  form { display: flex; gap: 0.5rem; }
</style>
