<script lang="ts">
import { onMount } from 'svelte'
import { live } from '../live/index.ts'
import { session } from '../session/index.ts'
import {
  NO_NODES,
  NODES_FOOTER,
  NODES_POLL_MS,
  needsPoll,
  nodeRowsOf,
  nodesSummary,
} from './nodes-view.ts'

let now = $state(Date.now())
let loaded = $state(false)

onMount(() => {
  live.reload()
  loaded = true
  const clock = setInterval(() => (now = Date.now()), 10_000)
  // members get no node events: ask again while the page is open
  const poll = needsPoll(session.me?.role)
    ? setInterval(() => live.reload(), NODES_POLL_MS)
    : undefined
  return () => {
    clearInterval(clock)
    if (poll !== undefined) clearInterval(poll)
  }
})

const rows = $derived(nodeRowsOf(live.nodes, now))
</script>

<svelte:head><title>Nodes · Keith</title></svelte:head>

<section class="k-page">
  <h1>Nodes</h1>
  <p class="k-sub">{rows.length === 0 ? 'Paired devices' : nodesSummary(live.nodes)}</p>

  {#if rows.length === 0}
    <p class="k-muted">{loaded ? NO_NODES : 'Loading…'}</p>
  {:else}
    <div class="k-tablewrap">
      <table class="k-table">
        <thead>
          <tr>
            <th scope="col">Status</th><th scope="col">Name</th><th scope="col">Platform</th><th scope="col">Version</th>
            <th scope="col">Last seen</th><th scope="col">Shell</th><th scope="col">Drivers and capabilities</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr class:off={row.status !== 'online'}>
              <td><span class="k-badge {row.tone}"><span aria-hidden="true">{row.icon}</span> {row.status}</span></td>
              <td class="mono">{row.name}</td>
              <td class="mono">{row.platform}</td>
              <td class="mono">{row.version}</td>
              <td>{row.seen}</td>
              <td><span class="k-badge" class:warning={row.shellOn}>{row.shell}</span></td>
              <td>
                {#each row.drivers as line}<div class="mono line">{line}</div>{/each}
                {#each row.refused as line}<div class="mono line refused">{line}</div>{/each}
                {#if row.drivers.length === 0 && row.refused.length === 0}<span class="k-muted">none announced</span>{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
  <p class="k-hint foot">{NODES_FOOTER}</p>
</section>

<style>
  .off td { color: var(--k-text-muted); }
  .line { font-size: 0.82rem; }
  .refused { color: var(--k-warning); }
  .foot { margin-top: 1rem; }
</style>
