<script lang="ts">
import { LEVELS } from '@keith/app-model'
import type { DisclosureAudience, DisclosureLevel } from '@keith/contracts'
import { onMount } from 'svelte'
import { PushPanel } from '../push/index.ts'
import { toasts } from '../toasts/index.ts'
import { presenceMine } from './mine.svelte.ts'
import { LEVEL_LABEL, presenceViewOf } from './presence-view.ts'
import StatusForm from './StatusForm.svelte'

onMount(() => {
  presenceMine.start()
  return () => presenceMine.stop()
})

const mine = $derived(presenceMine.mine)
const view = $derived(mine === undefined ? undefined : presenceViewOf(mine, presenceMine.now))
const stated = $derived(mine !== undefined && (mine.status.kind ?? null) !== null)

async function change(audience: string, level: string): Promise<void> {
  try {
    await presenceMine.setLevel(audience as DisclosureAudience, level as DisclosureLevel)
  } catch (e) {
    toasts.push(`Failed to change: ${e instanceof Error ? e.message : String(e)}`, {
      level: 'error',
    })
  }
}
</script>

<svelte:head><title>Presence · Keith</title></svelte:head>

<section class="k-page">
  <h1>Presence</h1>
  <p class="k-sub">What Keith knows about where you are, and who may read it. This is only what you see of yourself.</p>

  {#if presenceMine.error !== undefined && view === undefined}
    <p class="k-note error" role="alert">{presenceMine.error}</p>
  {:else if view === undefined}
    <p class="k-muted">Reading your presence…</p>
  {:else}
    {#if presenceMine.error !== undefined}<p class="k-note error" role="alert">{presenceMine.error}</p>{/if}
    <div class="you">
      <span class="k-muted">you</span>
      <strong class="state {view.tone}">{view.state}</strong>
      {#if view.where !== undefined}<span class="k-badge">{view.where}</span>{/if}
    </div>
    {#if view.status !== undefined}<p class="k-sub">Stated status: {view.status}</p>{/if}

    <h2>Set a status</h2>
    <StatusForm {stated} />

    <h2>Clients</h2>
    {#if view.clients.length === 0}
      <p class="k-muted">none yet</p>
    {:else}
      <div class="k-tablewrap">
        <table class="k-table">
          <thead><tr><th scope="col">State</th><th scope="col">Kind</th><th scope="col">Name</th><th scope="col">Where</th><th scope="col">Last seen</th><th scope="col">Last active</th></tr></thead>
          <tbody>
            {#each view.clients as c (c.id)}
              <tr>
                <td><span class="k-badge {c.tone}">{c.word}</span></td>
                <td class="mono">{c.kind}</td>
                <td>{c.label}</td>
                <td>{c.where}</td>
                <td>{c.seen}</td>
                <td>{c.active}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <h2>Who may read your state</h2>
    <div class="k-tablewrap">
      <table class="k-table">
        <thead><tr><th scope="col">Audience</th><th scope="col">May read</th></tr></thead>
        <tbody>
          {#each view.disclosure as row (row.audience)}
            <tr>
              <td>{row.who}</td>
              <td>
                <select class="k-input level" aria-label="What {row.who} may read" value={row.level} onchange={(e) => change(row.audience, e.currentTarget.value)}>
                  {#each LEVELS as level}<option value={level}>{LEVEL_LABEL[level]}</option>{/each}
                </select>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="k-hint">Busy or available shows only that; State and note adds your note and the time it ends.</p>
  {/if}

  <PushPanel />
</section>

<style>
  .you { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; margin-bottom: 0.5rem; }
  .state { font-size: 1.2rem; }
  .state.success { color: var(--k-success); }
  .state.warning { color: var(--k-warning); }
  .state.info { color: var(--k-info); }
  .state.muted { color: var(--k-text-muted); }
  .level { width: auto; min-width: 12rem; appearance: auto; }
</style>
