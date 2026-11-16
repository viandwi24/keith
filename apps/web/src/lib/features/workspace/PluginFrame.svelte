<script lang="ts">
import type { HostToApp } from '@keith/contracts'
import { onDestroy, untrack } from 'svelte'
import type { WindowApp } from './apps.ts'
import {
  bridgeLimiter,
  cleanError,
  cleanTitle,
  initMessage,
  paramsKey,
  paramsMessage,
  parseAppMessage,
  pluginFrameSrc,
  proposedParams,
  runCall,
} from './bridge.ts'
import { workspace } from './workspace.svelte.ts'

// A plugin app in its sandboxed iframe (ADR-0038 §6–7, docs/specs/plugin-web-apps.md). `sandbox="allow-scripts"` and never
// `allow-same-origin`: the frame has an opaque origin, so it cannot read the cookie, call the API or reach this page. Every message
// from it goes through `bridge.ts`; only messages whose source is this frame's window are read.

let {
  app,
  params,
  windowId,
}: {
  app: WindowApp
  params: Record<string, unknown> | undefined
  windowId: string | undefined
} = $props()

const src = $derived('url' in app.entry ? pluginFrameSrc(app.entry.url) : undefined)
let frame: HTMLIFrameElement | undefined = $state()
let width = $state(0)
let height = $state(0)
let ready = $state(false)
/** The app's own title (`setTitle`), shown in this frame's bar only: the window's title stays the one in the workspace. */
let title = $state('')
let failure = $state('')
/** The params the app last saw (sent or proposed by it): a change of `params` to the same value is not sent back. */
let sentKey = ''
let proposeTimer: ReturnType<typeof setTimeout> | undefined

// The frame's origin is opaque, so the only target that reaches it is '*'. That is safe because the host never sends a secret:
// init carries params, theme, language and size; params and results carry what the window and the plugin route already answer.
function post(message: HostToApp): void {
  frame?.contentWindow?.postMessage(message, '*')
}

function onmessage(event: MessageEvent): void {
  const message = parseAppMessage(event.data, frame?.contentWindow, event.source)
  if (message === undefined) return
  switch (message.type) {
    case 'ready':
      ready = true
      sentKey = paramsKey(params)
      post(initMessage({ params, language: navigator.language, size: { w: width, h: height } }))
      return
    case 'call':
      if (windowId === undefined) return
      void runCall({
        app,
        windowId,
        message,
        fetch: globalThis.fetch.bind(globalThis),
        limiter: bridgeLimiter,
      }).then(post)
      return
    case 'setParams': {
      if (windowId === undefined) return
      const id = windowId
      const next = message.params
      clearTimeout(proposeTimer)
      // a pan or a zoom sends many proposals: the last one in 300 ms is applied, if it differs from the window's
      proposeTimer = setTimeout(() => {
        const valid = proposedParams(next, params)
        if (valid === undefined) return
        sentKey = paramsKey(valid)
        workspace.apply({ op: 'window.setParams', id, params: valid })
      }, 300)
      return
    }
    case 'setTitle':
      title = cleanTitle(message.title)
      return
    case 'error':
      failure = cleanError(message.message)
      return
  }
}

// a change of the window's params by Keith or the person reaches the app
$effect(() => {
  const key = paramsKey(params)
  if (!ready || key === sentKey) return
  sentKey = key
  untrack(() => post(paramsMessage(params)))
})

// a new page in the frame waits for its own `ready`
$effect(() => {
  void src
  untrack(() => {
    ready = false
    title = ''
    failure = ''
  })
})

onDestroy(() => clearTimeout(proposeTimer))
</script>

<svelte:window {onmessage} />

{#if src === undefined}
  <p class="note">This app cannot be shown: its page is not served by Keith.</p>
{:else}
  <div class="plugin">
    {#if title !== '' || failure !== ''}
      <div class="bar">
        {#if title !== ''}<span class="title">{title}</span>{/if}
        {#if failure !== ''}<span class="failure" role="status">{failure}</span>{/if}
      </div>
    {/if}
    <div class="box" bind:clientWidth={width} bind:clientHeight={height}>
      <iframe bind:this={frame} {src} title={app.title} sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
    </div>
  </div>
{/if}

<style>
  .plugin { height: 100%; min-height: 0; display: flex; flex-direction: column; }
  .bar { display: flex; gap: 8px; align-items: center; padding: 4px 8px; font-size: 11px; color: var(--k-text-muted); border-bottom: 1px solid var(--k-border); }
  .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .failure { margin-left: auto; color: var(--k-danger); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .box { flex: 1; min-height: 0; }
  iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
  .note { margin: 0; padding: 16px; color: var(--k-text-muted); font-size: 12px; }
</style>
