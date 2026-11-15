<script lang="ts">
import type { BrainRegion } from '@keith/contracts'
import { G } from '@keith/ui/tokens'
import { approvals } from '../approvals/index.ts'
import { lampRows, live, regionLabel } from '../live/index.ts'
import { NO_TRACE, regionsInTrace, traceHeading, traceRowsOf } from './trace-view.ts'

const GLYPH = { lit: G.dot, working: G.working, idle: G.idle } as const
const WORD = { lit: 'active', working: 'working', idle: 'idle' } as const

let region = $state<BrainRegion | ''>('')

const waiting = $derived(approvals.answerable.length)
const lamps = $derived(lampRows(live.lamps, waiting))
const cortex = $derived(lamps.find((l) => l.region === 'cortex')?.count ?? 0)
const trace = $derived(live.brain.trace)
const rows = $derived(traceRowsOf(trace, region === '' ? undefined : region))
const regions = $derived(regionsInTrace(trace))
const last = $derived(
  live.brain.dreaming !== undefined
    ? `dreaming${G.ellipsis}`
    : live.brain.last === undefined
      ? 'no activity yet'
      : live.brain.last.text,
)
</script>

<svelte:head><title>Brain · Keith</title></svelte:head>

<section class="k-page">
  <h1>Brain</h1>
  <p class="k-sub">The regions light up as Keith works. {last}</p>

  <ul class="lamps" aria-label="Brain regions">
    {#each lamps as lamp (lamp.region)}
      <li class="lamp {lamp.lamp}">
        <span class="glyph" aria-hidden="true">{GLYPH[lamp.lamp]}</span>
        <span class="name">{lamp.label}{lamp.count > 0 ? ` ×${lamp.count}` : ''}</span>
        <span class="word">{WORD[lamp.lamp]}</span>
      </li>
    {/each}
  </ul>

  <ul class="counts">
    <li><strong>{cortex}</strong> <span class="k-muted">{cortex === 1 ? 'worker running' : 'workers running'} (cortex)</span></li>
    <li><strong>{waiting}</strong> <span class="k-muted">{waiting === 1 ? 'approval waiting' : 'approvals waiting'} (amygdala)</span></li>
  </ul>

  <h2>Trace</h2>
  {#if trace.length === 0}
    <p class="k-muted">{NO_TRACE}</p>
  {:else}
    <div class="k-toolbar">
      <span class="k-muted">{traceHeading(trace.length, rows.length)}, newest first</span>
      <label class="k-hint" for="trace-region">Region</label>
      <select id="trace-region" class="k-input filter" bind:value={region}>
        <option value="">All regions</option>
        {#each regions as r}<option value={r}>{regionLabel(r)}</option>{/each}
      </select>
    </div>
    <div class="k-tablewrap">
      <table class="k-table">
        <thead><tr><th scope="col">Time</th><th scope="col">Region</th><th scope="col">Event</th></tr></thead>
        <tbody>
          {#each rows as row (row.key)}
            <tr><td class="mono">{row.time}</td><td>{row.label}</td><td class="text">{row.text}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .lamps { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: 0.6rem; margin: 0 0 1rem; padding: 0; list-style: none; }
  .lamp { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 0.1rem 0.6rem; padding: 0.7rem 0.9rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
  .glyph { grid-row: span 2; font-family: var(--font-mono); font-size: 1.5rem; color: var(--k-text-muted); }
  .name { font-weight: 600; }
  .word { font-size: 0.78rem; color: var(--k-text-muted); }
  .lit .glyph { color: var(--k-success); }
  .lit { border-color: var(--k-success); }
  .working .glyph { color: var(--k-info); }
  .working { border-color: var(--k-info); }
  .idle .name { color: var(--k-text-muted); font-weight: 400; }
  .counts { display: flex; flex-wrap: wrap; gap: 1.5rem; margin: 0; padding: 0; list-style: none; }
  .counts strong { font-size: 1.3rem; }
  .filter { width: auto; min-width: 10rem; padding: 0.3rem 0.5rem; appearance: auto; }
  .text { overflow-wrap: anywhere; }
</style>
