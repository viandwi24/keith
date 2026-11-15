<script lang="ts">
import { barsOf, count, inRunOrder, metricOf, microUsd, stampOf } from '@keith/app-model/manage'
import type { LlmCallRecord } from '@keith/contracts'

let {
  generations,
  kind,
  href,
}: {
  generations: readonly LlmCallRecord[]
  kind: 'tokens' | 'cost'
  /** A bar links to its generation. */
  href: (call: LlmCallRecord) => string
} = $props()

const W = 480
const H = 110
const ordered = $derived(inRunOrder(generations))
const geometry = $derived.by(() => {
  if (kind === 'cost')
    return {
      bars: barsOf(
        ordered.map((c) => metricOf(c, 'cost')),
        { width: W, height: H },
      ),
      out: [],
    }
  const tin = ordered.map((c) => metricOf(c, 'tokens-in'))
  const tout = ordered.map((c) => metricOf(c, 'tokens-out'))
  const peak = Math.max(...tin, ...tout, 0)
  return {
    bars: barsOf(tin, { width: W, height: H, peak }),
    out: barsOf(tout, { width: W, height: H, peak }),
  }
})
const peakText = $derived(
  kind === 'cost'
    ? microUsd(Math.max(0, ...ordered.map((c) => metricOf(c, 'cost'))))
    : count(Math.max(0, ...ordered.flatMap((c) => [c.tokensIn, c.tokensOut]))),
)
const name = $derived(kind === 'cost' ? 'Cost per generation' : 'Tokens per generation')
const tip = (c: LlmCallRecord): string =>
  kind === 'cost'
    ? `${stampOf(c.startedAt)} · ${microUsd(c.costMicro)}`
    : `${stampOf(c.startedAt)} · in ${count(c.tokensIn)} · out ${count(c.tokensOut)}`
</script>

<figure class="chart">
  <figcaption>
    <span>{name}</span>
    <span class="peak">peak {peakText}</span>
    {#if kind === 'tokens'}
      <span class="legend"><i class="swatch in"></i> in <i class="swatch out"></i> out</span>
    {/if}
  </figcaption>
  {#if ordered.length === 0}
    <p class="none">No generations.</p>
  {:else}
    <svg viewBox="0 0 {W} {H + 4}" role="img" aria-label="{name}, {ordered.length} generations, peak {peakText}" preserveAspectRatio="none">
      <line class="base" x1="0" y1={H + 0.5} x2={W} y2={H + 0.5} />
      {#each geometry.bars as bar (bar.at)}
        {@const call = ordered[bar.at]}
        {#if call !== undefined}
          <a href={href(call)} aria-label={tip(call)}>
            <title>{tip(call)}</title>
            {#if kind === 'tokens'}
              {@const out = geometry.out[bar.at]}
              <rect class="in" x={bar.x} y={bar.y} width={bar.width / 2} height={Math.max(bar.height, bar.value > 0 ? 1 : 0)} />
              {#if out !== undefined}
                <rect class="out" x={bar.x + bar.width / 2} y={out.y} width={bar.width / 2} height={Math.max(out.height, out.value > 0 ? 1 : 0)} />
              {/if}
            {:else}
              <rect class="cost" class:unknown={call.costMicro === null} x={bar.x} y={bar.y} width={bar.width} height={Math.max(bar.height, bar.value > 0 ? 1 : 0)} />
            {/if}
            <rect class="hit" x={bar.x - 1} y="0" width={bar.width + 2} height={H} />
          </a>
        {/if}
      {/each}
    </svg>
  {/if}
</figure>

<style>
  .chart { margin: 0; min-width: 0; }
  figcaption { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: baseline; margin-bottom: 0.25rem; font-size: 0.85rem; font-weight: 600; }
  .peak, .legend { color: var(--k-text-muted); font-weight: 400; font-size: 0.8rem; }
  .none { margin: 0; color: var(--k-text-muted); font-size: 0.85rem; }
  svg { width: 100%; height: 7rem; display: block; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
  .base { stroke: var(--border); stroke-width: 1; }
  .in { fill: var(--k-accent); }
  .out { fill: var(--k-info); }
  .cost { fill: var(--k-warning); }
  .cost.unknown { fill: var(--k-text-muted); }
  .hit { fill: transparent; }
  a:hover .in, a:hover .out, a:hover .cost, a:focus-visible .in, a:focus-visible .out, a:focus-visible .cost { opacity: 0.7; }
  .swatch { display: inline-block; width: 0.6rem; height: 0.6rem; border-radius: 2px; vertical-align: baseline; }
  .swatch.in { background: var(--k-accent); }
  .swatch.out { background: var(--k-info); }
</style>
