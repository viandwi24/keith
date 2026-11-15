<script lang="ts">
import { callLines } from '@keith/app-model/manage'
import type { LogsCallOutput } from '@keith/contracts'
import { onMount } from 'svelte'
import { appBase, getClient } from '../session/index.ts'
import LogLines from './LogLines.svelte'
import { Loader } from './loader.svelte.ts'
import { logsHref } from './logs-path.ts'

let { sessionId, callId }: { sessionId: string; callId: string } = $props()

const base = appBase()
const loader = new Loader<LogsCallOutput>()
// svelte-ignore state_referenced_locally
onMount(() => void loader.run(() => getClient().logs.call({ id: callId })))

const d = $derived(loader.data)
</script>

{#if loader.error !== undefined}
  <p class="k-note error" role="alert">{loader.code === 'NOT_FOUND' ? 'This generation is gone.' : loader.error}</p>
{:else if d === undefined}
  <p class="k-muted">Reading…</p>
{:else}
  <p class="raw">
    <a href={logsHref(base, { level: 'raw', sessionId, callId })}>Raw request and response JSON ›</a>
  </p>
  <LogLines lines={callLines(d)} />
{/if}

<style>
  .raw { margin: 0 0 1rem; }
</style>
