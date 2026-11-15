<script lang="ts">
import { page } from '$app/state'
import { approvals, inboxBadge } from '../approvals/index.ts'
import { appBase } from '../session/index.ts'
import { hrefOf, isActive, TABS } from './nav.ts'

const base = appBase()
</script>

<nav class="tabs" aria-label="Main">
  {#each TABS as item (item.id)}
    <a
      class="tab"
      class:active={isActive(base, page.url.pathname, item)}
      href={hrefOf(base, item)}
      aria-current={isActive(base, page.url.pathname, item) ? 'page' : undefined}
    >
      <span class="glyph" aria-hidden="true">{item.glyph}</span>
      {#if item.id === 'inbox' && inboxBadge(approvals.items.length)}
        <span class="badge" aria-label="{approvals.items.length} waiting">{inboxBadge(approvals.items.length)}</span>
      {/if}
      <span>{item.label}</span>
    </a>
  {/each}
</nav>

<style>
  .tabs {
    display: none;
    border-top: 1px solid var(--border);
    background: var(--k-bg);
    padding-bottom: env(safe-area-inset-bottom);
  }
  .tab {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
    padding: 0.55rem 0.25rem;
    font-size: 0.75rem;
    color: var(--k-text-muted);
    text-decoration: none;
  }
  .tab.active { color: var(--k-accent); }
  .badge { position: absolute; top: 0.2rem; left: calc(50% + 0.5rem); min-width: 1.1rem; padding: 0 0.3rem; font-size: 0.65rem; line-height: 1.1rem; text-align: center; color: var(--k-bg); background: var(--k-warning); border-radius: 999px; }
  .glyph { font-family: var(--font-mono); font-size: 1.1rem; }
  @media (max-width: 639px) {
    .tabs { display: flex; }
  }
</style>
