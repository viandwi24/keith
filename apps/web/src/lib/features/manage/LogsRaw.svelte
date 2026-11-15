<script lang="ts">
import { bodyNote } from '@keith/app-model/manage'
import type { LogsRawOutput } from '@keith/contracts'
import { onMount } from 'svelte'
import { getClient } from '../session/index.ts'
import CopyField from './CopyField.svelte'
import { Loader } from './loader.svelte.ts'

let { callId }: { callId: string } = $props()

const loader = new Loader<LogsRawOutput>()
// svelte-ignore state_referenced_locally
onMount(() => void loader.run(() => getClient().logs.raw({ callId })))

const d = $derived(loader.data)

/** The JSON pretty-printed; a body the cap cut (not valid JSON any more) is shown as it is. */
function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}
</script>

{#if loader.error !== undefined}
  <p class="k-note error" role="alert">{loader.code === 'NOT_FOUND' ? 'This generation is gone.' : loader.error}</p>
{:else if d === undefined}
  <p class="k-muted">Reading…</p>
{:else}
  {@const note = bodyNote(d.bodyState)}
  {#if note !== null}<p class="k-note warning">{note}</p>{/if}
  {#if d.truncated}<p class="k-note warning">Truncated: the body was cut to the size the wire carries.</p>{/if}
  {#each [['Request', d.request], ['Response', d.response]] as const as [label, body] (label)}
    <section>
      <div class="bar">
        <h2>{label}</h2>
        {#if body !== null}<CopyField text={pretty(body)} label="Copy {label.toLowerCase()}" />{/if}
      </div>
      {#if body === null}
        <p class="k-muted">No stored body.</p>
      {:else}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <pre tabindex="0" aria-label="{label} JSON">{pretty(body)}</pre>
      {/if}
    </section>
  {/each}
{/if}

<style>
  section { margin: 0 0 1.5rem; }
  .bar { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.4rem; }
  h2 { margin: 0; font-size: 1rem; font-weight: 600; }
  pre {
    margin: 0;
    padding: 0.75rem;
    max-height: 32rem;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: 0.8rem;
    line-height: 1.45;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    white-space: pre;
  }
</style>
