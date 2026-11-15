<script lang="ts">
import { appBase } from '#lib/features/session/index.ts'
import { hrefOf, itemOf, NAV, Placeholder } from '#lib/features/shell/index.ts'
import { page } from '$app/state'

const section = $derived(page.params.section ?? '')
const item = $derived(itemOf(section))
const base = appBase()
</script>

<svelte:head><title>{section === 'more' ? 'More' : (item?.label ?? 'Not found')} · Keith</title></svelte:head>

{#if section === 'more'}
  <nav class="more" aria-label="More">
    <h1>More</h1>
    {#each NAV as entry (entry.id)}
      <a href={hrefOf(base, entry)}><span aria-hidden="true">{entry.glyph}</span> {entry.label}</a>
    {/each}
  </nav>
{:else if item !== undefined}
  <Placeholder title={item.label} />
{:else}
  <Placeholder title="Not found" />
{/if}

<style>
  .more { display: grid; gap: 0.25rem; padding: 1.5rem; }
  h1 { margin: 0 0 0.75rem; font-size: 1.4rem; font-weight: 600; }
  a { padding: 0.75rem; border-radius: var(--radius); color: var(--k-text); text-decoration: none; }
  a:hover { background: var(--surface); }
  span { display: inline-block; width: 1.5rem; font-family: var(--font-mono); color: var(--k-text-muted); }
</style>
