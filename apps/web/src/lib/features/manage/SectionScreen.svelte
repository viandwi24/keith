<script lang="ts">
import type { ActionSpec, Row } from '@keith/app-model/manage'
import { onMount } from 'svelte'
import { session } from '../session/index.ts'
import ActionDialog from './ActionDialog.svelte'
import { ActionFlow } from './action-flow.svelte.ts'
import DataTable from './DataTable.svelte'
import { sectionEnv } from './env.ts'
import ManageHeader from './ManageHeader.svelte'
import NoteDialog from './NoteDialog.svelte'
import ProviderAddDialog from './ProviderAddDialog.svelte'
import RowDrawer from './RowDrawer.svelte'
import { SectionStore } from './section.svelte.ts'
import { canOpen, sectionOf, splitFact } from './sections.ts'

let { id }: { id: string } = $props()

// the section is made once per mount (the route keys this component on the id)
// svelte-ignore state_referenced_locally
const meta = sectionOf(id)
// svelte-ignore state_referenced_locally
const store = new SectionStore(id, sectionEnv(id === 'audit' ? { limit: 500 } : {}))
const flow = new ActionFlow(() => void store.reload())

let openId = $state<string | undefined>(undefined)
let addProvider = $state(false)

const body = $derived(store.body)
const allowed = $derived(canOpen(session.me, id))
const openRow = $derived(body.rows.find((r) => r.id === openId))
// the provider form is drawn from the providers' own field list, so the generic add action steps aside
const custom = $derived(id === 'providers' && body.actions.some((a) => a.id === 'providers.add'))
const actions = $derived(
  custom ? body.actions.filter((a) => a.id !== 'providers.add') : body.actions,
)

function run(action: ActionSpec): void {
  openId = undefined
  flow.start(action)
}
const open = (row: Row): void => {
  openId = row.id
}

onMount(() => {
  if (allowed) void store.reload()
})
</script>

<svelte:head><title>{meta?.title ?? 'Manage'} · Keith</title></svelte:head>

<section class="k-page">
  <ManageHeader title={meta?.title ?? 'Manage'}>
    {#if allowed}
      <button type="button" class="k-button" disabled={store.loading} onclick={() => void store.reload()}>
        {store.loading ? 'Reading…' : 'Reload'}
      </button>
      {#if custom}
        <button type="button" class="k-button" onclick={() => (addProvider = true)}>Add a connection</button>
      {/if}
      {#each actions as action (action.id)}
        <button type="button" class="k-button" title={action.hint} onclick={() => run(action)}>{action.label}</button>
      {/each}
    {/if}
  </ManageHeader>

  {#if meta === undefined || store.model === undefined}
    <p class="k-note error" role="alert">There is no such section.</p>
  {:else if !allowed}
    <p class="k-note warning" role="alert">Your role does not include {meta.title}.</p>
  {:else}
    {#if store.error !== undefined}
      <p class="k-note error" role="alert">{store.error}</p>
    {/if}
    {#if body.lines.length > 0}
      <dl class="facts">
        {#each body.lines as line, at (at)}
          {@const f = splitFact(line)}
          {#if f.label === ''}
            <p class="sentence">{f.value}</p>
          {:else}
            <div><dt>{f.label}</dt><dd>{f.value}</dd></div>
          {/if}
        {/each}
      </dl>
    {/if}
    {#if body.header !== undefined}
      {#if store.loading && body.rows.length === 0 && store.error === undefined}
        <p class="k-muted">Reading…</p>
      {:else}
        <DataTable
          header={body.header}
          rows={body.rows}
          empty={body.empty ?? 'Nothing here.'}
          label={meta.title}
          onopen={open}
        />
      {/if}
    {:else if store.loading && body.lines.length === 0}
      <p class="k-muted">Reading…</p>
    {/if}
  {/if}
</section>

<RowDrawer row={openRow} header={body.header ?? []} onclose={() => (openId = undefined)} onaction={run} />
<ActionDialog {flow} />
<NoteDialog {flow} />
{#if custom}<ProviderAddDialog bind:open={addProvider} ondone={() => void store.reload()} />{/if}

<style>
  .facts { margin: 0 0 1rem; display: grid; gap: 0.25rem; }
  .facts > div { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: 0.75rem; }
  dt { color: var(--k-text-muted); font-size: 0.9rem; }
  dd { margin: 0; font-family: var(--font-mono); font-size: 0.9rem; overflow-wrap: anywhere; }
  .sentence { margin: 0; color: var(--k-text-muted); }
  @media (max-width: 639px) { .facts > div { grid-template-columns: 6rem minmax(0, 1fr); } }
</style>
