<script lang="ts">
import type { ViewMenuItem } from '@keith/contracts'
import { onMount } from 'svelte'
import { appBase, getClient } from '../session/index.ts'
import { viewRoute } from './routes.ts'

const base = appBase()
let items = $state<ViewMenuItem[] | undefined>()
let failed = $state(false)

onMount(() => {
  let live = true
  getClient()
    .viewMenu()
    .then((menu) => {
      if (live) items = menu.items
    })
    .catch(() => {
      if (live) failed = true
    })
  return () => {
    live = false
  }
})
</script>

<svelte:head><title>Apps · Keith</title></svelte:head>

<section class="k-page">
  <h1>Apps</h1>
  <p class="k-sub">Views that plugins offer you. Each runs in the core and is drawn here as a terminal.</p>

  {#if failed}
    <p class="k-note error" role="alert">Could not read the list of apps. The core may be unreachable.</p>
  {:else if items === undefined}
    <p class="k-muted">Loading…</p>
  {:else if items.length === 0}
    <p class="k-muted">No plugin offers you a view yet.</p>
  {:else}
    <ul class="list">
      {#each items as item (item.viewId)}
        <li>
          <a class="item" href={`${base}${viewRoute(item.viewId)}`}>
            <strong>{item.label}</strong>
            <span class="k-muted">{item.plugin}</span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .list { list-style: none; margin: 1rem 0 0; padding: 0; display: grid; gap: 0.5rem; max-width: 36rem; }
  .item { display: flex; justify-content: space-between; gap: 1rem; padding: 0.75rem 1rem; color: inherit; text-decoration: none; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
  .item:hover { background: var(--surface-strong); }
</style>
