<script lang="ts">
import type { PersonBar } from './budget-view.ts'

let { people }: { people: readonly PersonBar[] } = $props()

const ROW = 34
const LABEL = 130
const WIDTH = 640
const TRACK = WIDTH - LABEL - 80
const height = $derived(people.length * ROW + 8)
const summary = $derived(`Spend per person this month: ${people.map((p) => p.label).join('; ')}`)
</script>

<svg viewBox="0 0 {WIDTH} {height}" role="img" aria-label={summary} class="chart">
  {#each people as p, i (p.id)}
    {@const y = i * ROW + 4}
    <g>
      <title>{p.label}</title>
      <text x="0" y={y + 18} class="who">{p.who.length > 16 ? `${p.who.slice(0, 15)}…` : p.who}</text>
      <rect x={LABEL} {y} width={TRACK} height="22" rx="4" class="track" />
      <rect x={LABEL} {y} width={(TRACK * p.spentPercent) / 100} height="22" rx="4" class="bar {p.tone ?? ''}" />
      {#if p.capPercent !== undefined}
        <line x1={LABEL + (TRACK * p.capPercent) / 100} x2={LABEL + (TRACK * p.capPercent) / 100} y1={y - 3} y2={y + 25} class="cap" />
      {/if}
      <text x={LABEL + TRACK + 8} y={y + 16} class="amt">{p.spent}</text>
    </g>
  {/each}
</svg>

<style>
  .chart { display: block; width: 100%; max-width: 44rem; height: auto; }
  text { font: 13px var(--font-ui); fill: var(--k-text); }
  .amt { font-family: var(--font-mono); fill: var(--k-text-muted); }
  .track { fill: var(--surface-strong); }
  .bar { fill: var(--k-accent); }
  .bar.warning { fill: var(--k-warning); }
  .bar.danger { fill: var(--k-danger); }
  .cap { stroke: var(--k-text); stroke-width: 2; stroke-dasharray: 3 2; }
</style>
