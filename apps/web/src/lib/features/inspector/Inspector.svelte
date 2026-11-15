<script lang="ts">
import { approvals } from '../approvals/index.ts'
import { OrbCanvas, orbState } from '../home/index.ts'
import { budgetBar, lampRows, live, nodeRows, taskRows } from '../live/index.ts'
import { appBase } from '../session/index.ts'

const base = appBase()
const lamps = $derived(lampRows(live.lamps, approvals.answerable.length))
const tasks = $derived(taskRows(live.tasks))
const nodes = $derived(nodeRows(live.nodes))
const budget = $derived(budgetBar(live.budget))
</script>

<div class="inspector">
  <div class="mini"><OrbCanvas mode={orbState.mode} size={96} label="Keith" /><span class="mode">{orbState.mode}</span></div>

  <section aria-labelledby="insp-brain">
    <h2 id="insp-brain">Brain</h2>
    <ul class="lamps">
      {#each lamps as lamp (lamp.region)}
        <li class="lamp {lamp.lamp}">
          <span class="dot" aria-hidden="true"></span>
          <span class="name">{lamp.label}{lamp.count > 0 ? ` ×${lamp.count}` : ''}</span>
          <span class="k-sr-only">{lamp.lamp}</span>
        </li>
      {/each}
    </ul>
  </section>

  <section aria-labelledby="insp-tasks">
    <h2 id="insp-tasks">Tasks</h2>
    {#if tasks.length === 0}
      <p class="empty">Nothing running.</p>
    {:else}
      <ul class="rows">
        {#each tasks as task (task.id)}
          <li><a href="{base}/tasks"><span class="icon {task.tone}" aria-hidden="true">{task.icon}</span> {task.label} <span class="status">{task.status}</span></a></li>
        {/each}
      </ul>
    {/if}
  </section>

  <section aria-labelledby="insp-nodes">
    <h2 id="insp-nodes">Nodes</h2>
    {#if nodes.length === 0}
      <p class="empty">None paired.</p>
    {:else}
      <ul class="rows">
        {#each nodes as node (node.id)}
          <li><span class="icon" class:ok={node.online} aria-hidden="true">{node.online ? '●' : '○'}</span> {node.name} <span class="status">{node.label}</span></li>
        {/each}
      </ul>
    {/if}
  </section>

  <section aria-labelledby="insp-budget">
    <h2 id="insp-budget">Budget</h2>
    {#if budget === undefined}
      <p class="empty">Not loaded yet.</p>
    {:else}
      <p class="spend">{budget.text}</p>
      {#if budget.percent !== undefined}
        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={budget.percent} aria-label="Budget used">
          <span class="fill {budget.tone ?? ''}" style:width="{budget.percent}%"></span>
        </div>
      {/if}
      {#if budget.warning}<p class="warn {budget.tone}">! {budget.warning}</p>{/if}
    {/if}
  </section>

  <section aria-labelledby="insp-approvals">
    <h2 id="insp-approvals">Approvals</h2>
    {#if approvals.answerable.length === 0}
      <p class="empty">None waiting.</p>
    {:else}
      <a class="pending" href="{base}/inbox">{approvals.answerable.length} waiting in the Inbox</a>
    {/if}
  </section>
</div>

<style>
  .inspector { display: grid; gap: 1.25rem; padding: 1.25rem; }
  .mini { display: flex; align-items: center; gap: 0.75rem; }
  .mode { font-family: var(--font-mono); font-size: 0.85rem; color: var(--k-text-muted); }
  h2 { margin: 0 0 0.5rem; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--k-text-muted); font-weight: 600; }
  ul { margin: 0; padding: 0; list-style: none; }
  .lamps { display: grid; grid-template-columns: 1fr 1fr; gap: 0.2rem 0.75rem; font-size: 0.85rem; }
  .lamp { display: flex; align-items: center; gap: 0.4rem; color: var(--k-text-muted); }
  .dot { width: 0.55rem; height: 0.55rem; border-radius: 50%; border: 1px solid var(--k-text-muted); }
  .lamp.lit { color: var(--k-text); }
  .lamp.lit .dot { background: var(--k-accent); border-color: var(--k-accent); }
  .lamp.working { color: var(--k-text); }
  .lamp.working .dot { background: var(--k-success); border-color: var(--k-success); }
  .rows { display: grid; gap: 0.3rem; font-size: 0.85rem; }
  .rows a { color: inherit; text-decoration: none; }
  .icon { display: inline-block; width: 1rem; font-family: var(--font-mono); color: var(--k-text-muted); }
  .icon.info, .icon.ok { color: var(--k-success); }
  .icon.warning { color: var(--k-warning); }
  .icon.danger { color: var(--k-danger); }
  .status { color: var(--k-text-muted); font-size: 0.78rem; }
  .empty { margin: 0; color: var(--k-text-muted); font-size: 0.85rem; }
  .spend { margin: 0 0 0.4rem; font-size: 0.85rem; }
  .bar { height: 0.45rem; background: var(--surface-strong); border-radius: 999px; overflow: hidden; }
  .fill { display: block; height: 100%; background: var(--k-accent); }
  .fill.warning { background: var(--k-warning); }
  .fill.danger { background: var(--k-danger); }
  .warn { margin: 0.4rem 0 0; font-size: 0.8rem; }
  .warn.warning { color: var(--k-warning); }
  .warn.danger { color: var(--k-danger); }
  .pending { color: var(--k-warning); font-size: 0.85rem; }
</style>
