<script lang="ts">
import { appBase } from '../session/index.ts'
import { approvals } from './approvals.svelte.ts'
import { lineView } from './consent-line.ts'

const view = $derived(lineView(approvals.items, approvals.now, appBase()))
</script>

{#if view !== undefined}
  <p class="line" role="status" data-kind={view.kind}>
    <span>{view.text}</span>
    <a href={view.href}>{view.linkLabel}</a>
  </p>
{/if}

<style>
  .line { max-width: 760px; width: 100%; margin: 0 auto; padding: 0 1rem 0.4rem; font-size: 0.85rem; color: var(--k-text-muted); font-variant-numeric: tabular-nums; }
  .line span { margin-right: 0.4rem; }
  a { color: var(--k-accent); }
</style>
