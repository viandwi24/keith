<script lang="ts">
import { onDestroy, onMount } from 'svelte'
import { createNow } from '../connection/index.ts'
import { session } from '../session/index.ts'
import { toasts } from '../toasts/index.ts'
import DeviceWait from './DeviceWait.svelte'
import FlowForm from './FlowForm.svelte'
import IdentifyForm from './IdentifyForm.svelte'
import { SETUP_HINT } from './login-text.ts'
import { LoginModel } from './sign-in.svelte.ts'
import { busyText, showSetupHint } from './sign-in-view.ts'

const model = new LoginModel()
const now = createNow()
const current = $derived(model.state)

onMount(() => model.start())
onDestroy(() => model.dispose())

// an `address` step with no problem is a step back to the start: ask the core again
$effect(() => {
  if (current.step === 'address' && current.problem === undefined && current.address !== '')
    model.start()
})

// signed in: read who and tell the person; the session gate (root layout) then moves them to where they wanted
let finishing = false
$effect(() => {
  if (current.step !== 'done' || finishing) return
  finishing = true
  void (async () => {
    await session.load()
    if (current.step === 'done' && current.person !== undefined)
      toasts.push(`signed in as ${current.person.name}`, { level: 'success' })
    if (current.step === 'done' && current.note !== undefined)
      toasts.push(current.note, { level: 'warning', ms: 10000 })
  })()
})
</script>

<svelte:head><title>Sign in · Keith</title></svelte:head>

<main class="login">
  <div class="card">
    <h1><span aria-hidden="true">✳</span> KEITH</h1>
    <h2>Sign in</h2>
    <p class="core">{globalThis.location?.origin}</p>

    {#if current.step === 'identify'}
      {#key current.core}<IdentifyForm signIn={model.signIn} step={current} now={now.value} />{/key}
    {:else if current.step === 'flow'}
      <FlowForm signIn={model.signIn} flow={current} now={now.value} />
    {:else if current.step === 'device'}
      <DeviceWait signIn={model.signIn} step={current} now={now.value} />
    {:else if current.step === 'error'}
      <p class="error" role="alert"><span aria-hidden="true">✕</span> {current.message}</p>
      {#if current.retryable}
        <button class="k-button" type="button" onclick={() => void model.signIn.retry()}>Try again</button>
      {/if}
    {:else if current.step === 'address' && current.problem !== undefined}
      <p class="error" role="alert"><span aria-hidden="true">✕</span> {current.problem}</p>
      <button class="k-button" type="button" onclick={() => model.start()}>Try again</button>
    {:else if current.step === 'done'}
      <p class="muted">Signed in. Opening Keith …</p>
    {:else}
      <p class="muted" role="status">{busyText(current)}</p>
    {/if}

    {#if showSetupHint(current)}<p class="hint">{SETUP_HINT}</p>{/if}
  </div>
</main>

<style>
  .login { min-height: 100dvh; display: grid; place-items: center; padding: 1.5rem 1rem; }
  .card {
    width: min(26rem, 100%);
    padding: 2rem 1.75rem;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) * 2);
    background: var(--surface);
  }
  h1 { margin: 0; font-size: 1rem; letter-spacing: 0.16em; }
  h1 span { color: var(--k-accent); font-family: var(--font-mono); }
  h2 { margin: 1.5rem 0 0.25rem; font-size: 1.4rem; font-weight: 600; }
  .core { margin: 0 0 1.5rem; color: var(--k-text-muted); font-family: var(--font-mono); font-size: 0.8rem; overflow-wrap: anywhere; }
  .muted { color: var(--k-text-muted); }
  .error { color: var(--k-danger); margin: 0 0 1rem; }
  .error span { font-family: var(--font-mono); }
  .hint { margin: 1.5rem 0 0; color: var(--k-text-muted); font-size: 0.85rem; }
</style>
