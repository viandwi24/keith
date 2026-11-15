<script lang="ts">
import { onMount } from 'svelte'
import { ConfirmButton } from '../confirm/index.ts'
import { appBase } from '../session/index.ts'
import { taskBoard } from './tasks.svelte.ts'
import {
  filterCounts,
  filterTasks,
  STOP_CONFIRM,
  summaryLine,
  TASK_FILTERS,
  type TaskFilter,
  taskRowOf,
} from './tasks-view.ts'

const base = appBase()
let filter = $state<TaskFilter>('all')

onMount(() => {
  taskBoard.start()
  return () => taskBoard.stop()
})

const counts = $derived(filterCounts(taskBoard.tasks))
const rows = $derived(filterTasks(taskBoard.tasks, filter).map((t) => taskRowOf(t, taskBoard.now)))
</script>

<svelte:head><title>Tasks · Keith</title></svelte:head>

<section class="k-page">
  <h1>Tasks</h1>
  <p class="k-sub">{taskBoard.loaded ? summaryLine(taskBoard.tasks) : 'Loading…'}</p>

  {#if taskBoard.error !== undefined}<p class="k-note error" role="alert">{taskBoard.error}</p>{/if}

  <div class="k-toolbar" role="group" aria-label="Filter by status">
    {#each TASK_FILTERS as f (f.id)}
      <button type="button" class="k-chip" aria-pressed={filter === f.id} onclick={() => (filter = f.id)}>
        {f.label} <span class="k-muted">{counts[f.id]}</span>
      </button>
    {/each}
  </div>

  {#if taskBoard.loaded && taskBoard.tasks.length === 0}
    <p class="k-muted">No tasks yet. Ask Keith to research something and it shows up here.</p>
  {:else if rows.length === 0 && taskBoard.loaded}
    <p class="k-muted">No tasks match this filter.</p>
  {:else if rows.length > 0}
    <div class="k-tablewrap">
      <table class="k-table">
        <thead>
          <tr><th scope="col">Status</th><th scope="col">Agent</th><th scope="col">Task</th><th scope="col" class="num">Time</th><th scope="col"><span class="k-sr-only">Actions</span></th></tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr>
              <td><span class="k-badge {row.tone}"><span aria-hidden="true">{row.icon}</span> {row.status}</span></td>
              <td class="mono">{row.agent}</td>
              <td class="desc"><a href="{base}/tasks/{encodeURIComponent(row.id)}">{row.description}</a></td>
              <td class="num mono">{row.time}</td>
              <td class="act">
                {#if row.active}<ConfirmButton label="Stop" question={STOP_CONFIRM} yes="Yes, stop" no="Keep running" danger busy={taskBoard.stopping.includes(row.id)} busyLabel="Stopping…" onconfirm={() => taskBoard.stopTask(row.id)} />{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .desc { max-width: 28rem; overflow-wrap: anywhere; }
  .act { text-align: right; }
</style>
