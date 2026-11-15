<script lang="ts">
import type { LogLine } from '@keith/app-model/manage'
import { splitFact } from './sections.ts'

let { lines }: { lines: readonly LogLine[] } = $props()
</script>

<div class="lines">
  {#each lines as line, at (at)}
    {#if line.fact === true}
      {@const f = splitFact(line.text)}
      <div class="fact"><span class="k">{f.label}</span><span class="v">{f.value}</span></div>
    {:else}
      <div class="line {line.tone ?? 'text'}" class:bold={line.bold === true}>{line.text.trim() === '' ? ' ' : line.text}</div>
    {/if}
  {/each}
</div>

<style>
  .lines { font-family: var(--font-mono); font-size: 0.85rem; line-height: 1.5; }
  .fact { display: grid; grid-template-columns: 7.5rem minmax(0, 1fr); gap: 0.75rem; }
  .k { color: var(--k-text-muted); }
  .v, .line { white-space: pre-wrap; overflow-wrap: anywhere; }
  .bold { font-weight: 700; }
  .muted { color: var(--k-text-muted); }
  .accent, .assistant { color: var(--k-accent); }
  .success { color: var(--k-success); }
  .warning { color: var(--k-warning); }
  .danger { color: var(--k-danger); }
  .info, .tool { color: var(--k-info); }
  @media (max-width: 639px) { .fact { grid-template-columns: 6rem minmax(0, 1fr); } }
</style>
