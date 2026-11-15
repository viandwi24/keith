<script lang="ts">
import { Dialog } from 'bits-ui'
import type { Snippet } from 'svelte'
import { page } from '$app/state'
import { OfflineBanner } from '../connection/index.ts'
import Rail from './Rail.svelte'
import { rail } from './rail.svelte.ts'
import TabBar from './TabBar.svelte'
import TopBar from './TopBar.svelte'

// `inspector` is a snippet, not an import: the inspector draws the orb and the live data, which read this feature (theme, motion)
let { children, inspector }: { children: Snippet; inspector: Snippet } = $props()

// Manage is tables first: its own section list takes the room the inspector column would (the drawer still opens it)
const wide = $derived(/\/manage(\/|$)/.test(page.url.pathname))
</script>

<div class="shell">
  <TopBar />
  <OfflineBanner />
  <div class="body" class:collapsed={rail.collapsed} class:wide>
    <Rail />
    <main id="main" tabindex="-1">{@render children()}</main>
    {#if !wide}<aside class="inspector" aria-label="Inspector">{@render inspector()}</aside>{/if}
  </div>
  <TabBar />
</div>

<Dialog.Root bind:open={rail.inspectorOpen}>
  <Dialog.Portal>
    <Dialog.Overlay class="k-overlay" />
    <Dialog.Content class="k-drawer">
      <Dialog.Title class="k-sr-only">Inspector</Dialog.Title>
      <Dialog.Description class="k-sr-only">What is going on in Keith right now</Dialog.Description>
      {@render inspector()}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  /* A column, not grid rows: the offline banner and the tab bar render nothing at times, and fixed
     rows would then shift the body into the wrong track. */
  .shell { display: flex; flex-direction: column; height: 100dvh; }
  .body {
    display: grid;
    grid-template-columns: 4rem minmax(0, 1fr);
    flex: 1;
    min-height: 0;
  }
  main { overflow-y: auto; min-width: 0; outline: none; }
  .inspector { display: none; }
  @media (min-width: 1100px) {
    .body { grid-template-columns: 14rem minmax(0, 1fr) 20rem; }
    .body.collapsed { grid-template-columns: 4rem minmax(0, 1fr) 20rem; }
    .body.wide { grid-template-columns: 14rem minmax(0, 1fr); }
    .body.wide.collapsed { grid-template-columns: 4rem minmax(0, 1fr); }
    .inspector { display: block; border-left: 1px solid var(--border); overflow-y: auto; }
  }
  @media (max-width: 639px) {
    .body { grid-template-columns: minmax(0, 1fr); }
  }
</style>
