<script lang="ts">
import '../app.css'
import { onMount } from 'svelte'
import favicon from '#lib/assets/favicon.svg'
import {
  afterSignIn,
  appBase,
  gateAction,
  isGuestPath,
  loginUrl,
  session,
} from '#lib/features/session/index.ts'
import { applyThemeMode, installTokens, readThemeMode } from '#lib/features/shell/index.ts'
import { ToastStack } from '#lib/features/toasts/index.ts'
import { goto } from '$app/navigation'
import { page } from '$app/state'
import type { LayoutProps } from './$types'

let { children }: LayoutProps = $props()
const base = appBase()

// the colour tokens are in the page before the first paint of any screen
installTokens(document)
applyThemeMode(document.documentElement, readThemeMode())

// the guest page has no sign-in and, on the guest listener, no owner API to ask
const onGuest = $derived(isGuestPath(base, page.url.pathname))

onMount(() => {
  if (!onGuest) void session.load()
})

const onLogin = $derived(
  page.url.pathname === `${base}/login` || page.url.pathname === `${base}/login/`,
)

$effect(() => {
  if (onGuest) return
  const action = gateAction(session.status, onLogin)
  if (action === 'to-login')
    void goto(loginUrl(base, page.url.pathname + page.url.search), { replaceState: true })
  else if (action === 'to-app')
    void goto(afterSignIn(base, page.url.searchParams.get('next')), { replaceState: true })
})

const ready = $derived(onGuest || gateAction(session.status, onLogin) === 'stay')
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
</svelte:head>

{#if ready}
  {#if !onGuest && session.status === 'error'}
    <main class="gate" role="alert">
      <p><span aria-hidden="true">✕</span> {session.error ?? 'the core did not answer'}</p>
      <button class="k-button" type="button" onclick={() => void session.load()}>Try again</button>
    </main>
  {:else}
    {@render children()}
  {/if}
{:else}
  <main class="gate" aria-busy="true"><p class="muted"><span aria-hidden="true">✳</span> Keith</p></main>
{/if}

<ToastStack />

<style>
  .gate { min-height: 100dvh; display: grid; place-content: center; justify-items: center; gap: 1rem; }
  .gate p { margin: 0; }
  .gate span { font-family: var(--font-mono); }
  .muted { color: var(--k-text-muted); }
</style>
