<script lang="ts">
import { onMount } from 'svelte'
import { Markdown } from '../chat/index.ts'
import { ConfirmButton } from '../confirm/index.ts'
import { appBase } from '../session/index.ts'
import { taskBoard } from './tasks.svelte.ts'
import { STOP_CONFIRM, taskDetailOf, whenText } from './tasks-view.ts'

let { id }: { id: string } = $props()
const base = appBase()

onMount(() => {
  taskBoard.start()
  return () => taskBoard.stop()
})

const task = $derived(taskBoard.tasks.find((t) => t.id === id))
const detail = $derived(task === undefined ? undefined : taskDetailOf(task, taskBoard.now))
</script>

<svelte:head><title>Task · Keith</title></svelte:head>

<section class="k-page">
  <a class="k-link-back" href="{base}/tasks">← All tasks</a>
  {#if detail === undefined}
    {#if !taskBoard.loaded}
      <p class="k-muted">Loading…</p>
    {:else if taskBoard.error !== undefined}
      <p class="k-note error" role="alert">{taskBoard.error}</p>
    {:else}
      <h1>Task not found</h1>
      <p class="k-muted">This task is not on the board any more.</p>
    {/if}
  {:else}
    <h1>{detail.agent}</h1>
    <p class="meta">
      <span class="k-badge {detail.tone}"><span aria-hidden="true">{detail.icon}</span> {detail.status}</span>
      <span class="k-muted">{detail.time} · {detail.steps}</span>
    </p>
    <p class="desc">{detail.description}</p>

    {#if detail.active}
      <div class="stop"><ConfirmButton label="Stop this task" question={STOP_CONFIRM} yes="Yes, stop" no="Keep running" danger busy={taskBoard.stopping.includes(detail.id)} busyLabel="Stopping…" onconfirm={() => taskBoard.stopTask(detail.id)} /></div>
    {/if}

    {#if detail.error !== undefined}<p class="k-note error" role="alert">{detail.error}</p>{/if}

    <h2>Result</h2>
    {#if detail.summary !== undefined}
      <div class="summary"><Markdown text={detail.summary} /></div>
    {:else}
      <p class="k-muted">{detail.emptySummary}</p>
    {/if}

    <h2>Details</h2>
    <dl>
      <dt>Started</dt><dd>{whenText(detail.createdAt)}</dd>
      <dt>Finished</dt><dd>{detail.finishedAt === undefined ? 'still running' : whenText(detail.finishedAt)}</dd>
      <dt>Parent session</dt><dd class="k-mono">{detail.parentSessionId}</dd>
      <dt>Task id</dt><dd class="k-mono">{detail.id}</dd>
    </dl>
  {/if}
</section>

<style>
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; margin: 0.25rem 0 0.75rem; }
  .desc { margin: 0 0 1rem; overflow-wrap: anywhere; }
  .stop { margin-bottom: 1rem; }
  .summary { padding: 0.75rem 1rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.35rem 1.25rem; margin: 0; font-size: 0.9rem; }
  dt { color: var(--k-text-muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
</style>
