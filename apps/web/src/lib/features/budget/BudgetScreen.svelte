<script lang="ts">
import { onMount } from 'svelte'
import { live } from '../live/index.ts'
import { budgetViewOf } from './budget-view.ts'
import PeopleChart from './PeopleChart.svelte'

onMount(() => live.reload())

const view = $derived(live.budget === undefined ? undefined : budgetViewOf(live.budget))
</script>

<svelte:head><title>Budget · Keith</title></svelte:head>

<section class="k-page">
  <h1>Budget</h1>
  <p class="k-sub">{view?.heading ?? 'this month'}</p>

  {#if view === undefined}
    <p class="k-muted">Loading the budget…</p>
  {:else}
    {#if view.warning !== undefined}
      <p class="k-note {view.tone ?? 'warning'}" role="status">{view.warning}</p>
    {/if}

    {#if view.bar !== undefined}
      <div class="meter">
        <div class="headline">
          <strong>{view.bar.percent === undefined ? 'no limit' : `${view.bar.percent}%`}</strong>
          <span class="k-muted">{view.bar.text}</span>
        </div>
        {#if view.bar.percent !== undefined}
          <div class="track" role="progressbar" aria-label="Share of the monthly limit spent" aria-valuemin="0" aria-valuemax="100" aria-valuenow={view.bar.percent}>
            <div class="fill {view.tone ?? ''}" style:width="{view.bar.percent}%"></div>
          </div>
        {/if}
      </div>
    {/if}

    <dl class="rows">
      {#each view.rows as [label, value]}
        <dt>{label}</dt><dd>{value}</dd>
      {/each}
    </dl>

    {#if view.unpriced.length > 0}
      <p class="k-note warning">Some models spent without a catalog price, so their cost is not counted: <span class="k-mono">{view.unpriced.join(', ')}</span></p>
    {/if}

    {#if !view.own && view.people.length > 0}
      <h2>Per person</h2>
      <PeopleChart people={view.people} />
      <div class="k-tablewrap table">
        <table class="k-table">
          <thead><tr><th scope="col">Person</th><th scope="col" class="num">Spent</th><th scope="col" class="num">Cap</th><th scope="col" class="num">Left</th></tr></thead>
          <tbody>
            {#each view.people as p (p.id)}
              <tr>
                <td>{p.who} {#if p.tone !== undefined}<span class="k-badge {p.tone}">{p.tone === 'danger' ? 'cap reached' : 'over 80%'}</span>{/if}</td>
                <td class="num">{p.spent}</td>
                <td class="num" class:k-muted={p.capPercent === undefined}>{p.cap}</td>
                <td class="num">{p.left}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
    <p class="k-hint foot">{view.footer}</p>
  {/if}
</section>

<style>
  .meter { max-width: 32rem; margin: 0 0 1.25rem; }
  .headline { display: flex; align-items: baseline; gap: 0.75rem; margin-bottom: 0.4rem; }
  .headline strong { font-size: 1.6rem; }
  .track { height: 0.6rem; background: var(--surface-strong); border-radius: 999px; overflow: hidden; }
  .fill { height: 100%; background: var(--k-accent); }
  .fill.warning { background: var(--k-warning); }
  .fill.danger { background: var(--k-danger); }
  .rows { display: grid; grid-template-columns: max-content 1fr; gap: 0.35rem 1.5rem; margin: 0; max-width: 32rem; }
  dt { color: var(--k-text-muted); }
  dd { margin: 0; font-variant-numeric: tabular-nums; }
  .table { margin-top: 1rem; }
  .foot { margin-top: 1rem; }
</style>
