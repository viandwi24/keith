<script lang="ts">
import type { Snippet } from 'svelte'
import { appBase } from '../session/index.ts'

let {
  title,
  back = true,
  children,
}: {
  title: string /** A phone shows the way back to the section list. */
  back?: boolean
  children?: Snippet
} = $props()
</script>

<header class="head">
  {#if back}<a class="k-link-back back" href="{appBase()}/manage">‹ Manage</a>{/if}
  <div class="row">
    <h1>{title}</h1>
    {#if children}<div class="tools">{@render children()}</div>{/if}
  </div>
</header>

<style>
  .head { margin: 0 0 1rem; }
  .row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; }
  h1 { margin: 0; font-size: 1.4rem; font-weight: 600; }
  .tools { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .back { margin-bottom: 0.25rem; }
  @media (min-width: 900px) { .back { display: none; } }
</style>
