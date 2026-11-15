<script lang="ts">
import {
  initialLogsState,
  KIND_CYCLE,
  type KindFilter,
  type LogsState,
  microUsd,
  reduceLogs,
  SESSION_HEADER,
  sessionRow,
  sessionsInput,
} from '@keith/app-model/manage'
import type { LogsSessionsOutput } from '@keith/contracts'
import { appBase, getClient, session } from '../session/index.ts'
import DataTable from './DataTable.svelte'
import { Loader } from './loader.svelte.ts'
import { logsHref } from './logs-path.ts'

const base = appBase()
const owner = session.me?.capabilities.includes('logs.read') === true
let logs = $state.raw<LogsState>(initialLogsState(owner))
let typed = $state('')
const loader = new Loader<LogsSessionsOutput>()
let timer: ReturnType<typeof setTimeout> | undefined

// a new query (filter, kind, scope or page) reads the list again
$effect(() => {
  const input = sessionsInput(logs)
  void loader.run(() => getClient().logs.sessions(input))
})

function filter(text: string): void {
  typed = text
  clearTimeout(timer)
  timer = setTimeout(() => {
    logs = reduceLogs(logs, { type: 'setFilter', text })
  }, 250)
}

const page = $derived(loader.data)
const rows = $derived((page?.sessions ?? []).map(sessionRow))
const total = $derived((page?.sessions ?? []).reduce((n, s) => n + s.costMicro, 0))
const calls = $derived((page?.sessions ?? []).reduce((n, s) => n + s.calls, 0))
const next = $derived(page?.nextCursor ?? null)
</script>

<div class="k-toolbar">
  <input
    class="k-input find"
    type="search"
    placeholder="Session id starts with…"
    aria-label="Filter sessions by id"
    value={typed}
    oninput={(e) => filter(e.currentTarget.value)}
  />
  <select
    class="k-input kind"
    aria-label="Filter by kind"
    value={logs.kind}
    onchange={(e) => {
      const want = e.currentTarget.value as KindFilter
      // the reducer cycles the kind: step to the one asked for
      let state = logs
      for (let i = 0; i < KIND_CYCLE.length && state.kind !== want; i++) state = reduceLogs(state, { type: 'cycleKind' })
      logs = state
    }}
  >
    {#each KIND_CYCLE as kind (kind)}<option value={kind}>{kind === 'all' ? 'all kinds' : kind}</option>{/each}
  </select>
  {#if owner}
    <label class="scope">
      <input type="checkbox" checked={logs.scope === 'everyone'} onchange={() => (logs = reduceLogs(logs, { type: 'toggleScope' }))} />
      Everyone’s sessions <span class="k-hint">(audited)</span>
    </label>
  {/if}
</div>

{#if loader.error !== undefined}<p class="k-note error" role="alert">{loader.error}</p>{/if}

{#if loader.loading && page === undefined}
  <p class="k-muted">Reading…</p>
{:else if page !== undefined}
  <DataTable
    header={SESSION_HEADER}
    {rows}
    empty="No session matches."
    label="Sessions"
    search={false}
    href={(row) => logsHref(base, { level: 'session', sessionId: row.id })}
  />
  <p class="foot k-hint">
    {rows.length} session{rows.length === 1 ? '' : 's'} on this page · {calls} calls · {microUsd(total)}
  </p>
  <div class="pager">
    <button type="button" class="k-button" disabled={logs.back.length === 0} onclick={() => (logs = reduceLogs(logs, { type: 'prevPage' }))}>‹ Newer</button>
    <button type="button" class="k-button" disabled={next === null} onclick={() => next !== null && (logs = reduceLogs(logs, { type: 'nextPage', cursor: next }))}>Older ›</button>
  </div>
{/if}

<style>
  .find { max-width: 18rem; }
  .kind { width: auto; }
  .scope { display: flex; align-items: center; gap: 0.4rem; font-size: 0.9rem; }
  .foot { margin: 0.5rem 0 0; }
  .pager { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
</style>
