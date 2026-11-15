<script lang="ts">
import {
  GENERATION_HEADER,
  generationRow,
  lowCacheIds,
  sessionLines,
} from '@keith/app-model/manage'
import type { LogsSessionOutput } from '@keith/contracts'
import { onMount } from 'svelte'
import { appBase, getClient } from '../session/index.ts'
import DataTable from './DataTable.svelte'
import LogLines from './LogLines.svelte'
import { Loader } from './loader.svelte.ts'
import { logsHref } from './logs-path.ts'
import TokenChart from './TokenChart.svelte'

let { id }: { id: string } = $props()

const base = appBase()
const loader = new Loader<LogsSessionOutput>()
// svelte-ignore state_referenced_locally
onMount(() => void loader.run(() => getClient().logs.session({ id })))

const d = $derived(loader.data)
const marked = $derived(d === undefined ? new Set<string>() : lowCacheIds(d.generations))
const rows = $derived((d?.generations ?? []).map((c) => generationRow(c, marked.has(c.id))))
const callHref = (callId: string): string =>
  logsHref(base, { level: 'call', sessionId: id, callId })
</script>

{#if loader.error !== undefined}
  <p class="k-note error" role="alert">{loader.code === 'NOT_FOUND' ? 'This session is gone.' : loader.error}</p>
{:else if d === undefined}
  <p class="k-muted">Reading…</p>
{:else}
  <LogLines lines={sessionLines(d)} />
  <div class="charts">
    <TokenChart generations={d.generations} kind="tokens" href={(c) => callHref(c.id)} />
    <TokenChart generations={d.generations} kind="cost" href={(c) => callHref(c.id)} />
  </div>
  <h2>Generations</h2>
  <DataTable
    header={GENERATION_HEADER}
    {rows}
    empty="No generations."
    label="Generations"
    search={false}
    href={(row) => callHref(row.id)}
  />
{/if}

<style>
  .charts { display: grid; gap: 1rem; margin: 1rem 0; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); }
  h2 { margin: 1.25rem 0 0.5rem; font-size: 1rem; font-weight: 600; }
</style>
