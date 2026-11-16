<script lang="ts">
import { onDestroy } from 'svelte'
import { workspace } from '../workspace.svelte.ts'
import { browserTarget, httpsTarget } from './params.ts'

// `web:browser { url }` (ADR-0038 §9): an https page in a sandboxed iframe, never with `allow-same-origin`. The domain and "Open in a
// new tab" are always shown above it. Many sites refuse to be framed and the browser does not tell the page: when the frame has not
// loaded in 8 s, a card with the domain and the way out replaces it.

let {
  params,
  windowId,
}: { params: Record<string, unknown> | undefined; windowId: string | undefined } = $props()

const LOAD_WAIT_MS = 8000
const target = $derived(browserTarget(params))
let loaded = $state(false)
let timedOut = $state(false)
let typed = $state('')
let typedError = $state('')
let timer: ReturnType<typeof setTimeout> | undefined

$effect(() => {
  const url = target.ok ? target.url : undefined
  loaded = false
  timedOut = false
  clearTimeout(timer)
  if (url !== undefined) timer = setTimeout(() => (timedOut = !loaded), LOAD_WAIT_MS)
  return () => clearTimeout(timer)
})
onDestroy(() => clearTimeout(timer))

function onload(): void {
  loaded = true
  timedOut = false
}

function go(event: SubmitEvent): void {
  event.preventDefault()
  const raw = typed.trim()
  const next = httpsTarget(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`)
  if (!next.ok) {
    typedError = next.reason === 'not-https' ? 'Only https pages' : 'Not a web address'
    return
  }
  typedError = ''
  if (windowId !== undefined)
    workspace.apply({ op: 'window.setParams', id: windowId, params: { url: next.url } })
}
</script>

{#if target.ok}
  <div class="browser">
    <div class="bar">
      <span class="domain" title={target.url}>{target.domain}</span>
      <a href={target.url} target="_blank" rel="noopener noreferrer">Open in a new tab</a>
    </div>
    {#if timedOut}
      <div class="card">
        <p class="head">This page did not open here</p>
        <p class="domain">{target.domain}</p>
        <p>Many sites refuse to be shown inside another page.</p>
        <a href={target.url} target="_blank" rel="noopener noreferrer">Open in a new tab</a>
      </div>
    {:else}
      {#key target.url}
        <iframe
          src={target.url}
          title={target.domain}
          sandbox="allow-scripts allow-forms allow-popups"
          referrerpolicy="no-referrer"
          {onload}
        ></iframe>
      {/key}
    {/if}
  </div>
{:else if target.reason === 'missing'}
  <form class="card" onsubmit={go}>
    <label for="browser-url-{windowId}" class="head">Open a page</label>
    <input id="browser-url-{windowId}" type="text" inputmode="url" placeholder="https://" bind:value={typed} />
    {#if typedError !== ''}<p role="status">{typedError}</p>{/if}
  </form>
{:else}
  <div class="card">
    <p class="head">{target.reason === 'not-https' ? 'Only https pages' : 'Not a web address'}</p>
    <p>This window can show only pages that start with https://.</p>
  </div>
{/if}

<style>
  .browser { height: 100%; min-height: 0; display: flex; flex-direction: column; }
  .bar { display: flex; align-items: center; gap: 12px; padding: 4px 8px; font-size: 11px; border-bottom: 1px solid var(--k-border); }
  .domain { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--k-text); }
  a { color: var(--k-accent); white-space: nowrap; }
  iframe { flex: 1; min-height: 0; width: 100%; border: 0; background: var(--k-bg); }
  .card { margin: auto; padding: 16px; max-width: 320px; display: flex; flex-direction: column; gap: 8px; font-size: 12px; color: var(--k-text-muted); }
  .card p { margin: 0; }
  .card .domain { flex: none; }
  .head { color: var(--k-text); font-size: 13px; }
  input { font: inherit; padding: 6px 8px; color: var(--k-text); background: var(--k-bg); border: 1px solid var(--k-border); }
</style>
