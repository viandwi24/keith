<script lang="ts">
import { page } from '$app/state'
import { approvals, inboxBadge } from '../approvals/index.ts'
import { appBase } from '../session/index.ts'
import { hrefOf, isActive, NAV } from './nav.ts'
import { rail } from './rail.svelte.ts'

const base = appBase()
</script>

<nav class="rail" class:collapsed={rail.collapsed} aria-label="Main">
  {#each NAV as item (item.id)}
    <a
      class="item"
      class:active={isActive(base, page.url.pathname, item)}
      href={hrefOf(base, item)}
      aria-current={isActive(base, page.url.pathname, item) ? 'page' : undefined}
      title={item.label}
    >
      <span class="glyph" aria-hidden="true">{item.glyph}</span>
      <span class="label">{item.label}</span>
      {#if item.id === 'inbox' && inboxBadge(approvals.items.length)}
        <span class="badge" aria-label="{approvals.items.length} waiting">{inboxBadge(approvals.items.length)}</span>
      {/if}
    </a>
  {/each}
</nav>

<style>
  .rail {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.75rem 0.5rem;
    border-right: 1px solid var(--border);
    overflow-y: auto;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.55rem 0.75rem;
    border-radius: var(--radius);
    color: var(--k-text-muted);
    text-decoration: none;
  }
  .item:hover { background: var(--surface); color: var(--k-text); }
  .item.active { background: var(--surface-strong); color: var(--k-accent); }
  .item { position: relative; }
  .badge { margin-left: auto; min-width: 1.2rem; padding: 0 0.35rem; font-size: 0.7rem; line-height: 1.2rem; text-align: center; color: var(--k-bg); background: var(--k-warning); border-radius: 999px; }
  .glyph { width: 1.25rem; text-align: center; font-family: var(--font-mono); flex: none; }
  /* tablet: the rail is always icons only */
  @media (max-width: 1099px) {
    .label { display: none; }
    .badge { position: absolute; top: 0.1rem; right: 0.1rem; margin: 0; }
    .item { justify-content: center; padding-inline: 0.5rem; }
  }
  @media (min-width: 1100px) {
    .collapsed .label { display: none; }
    .collapsed .badge { position: absolute; top: 0.1rem; right: 0.1rem; margin: 0; }
    .collapsed .item { justify-content: center; padding-inline: 0.5rem; }
  }
  @media (max-width: 639px) {
    .rail { display: none; }
  }
</style>
