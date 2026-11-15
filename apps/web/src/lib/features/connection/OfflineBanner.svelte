<script lang="ts">
import { createNow } from './clock.svelte.ts'
import { connection } from './connection.svelte.ts'
import { isOffline, offlineText, retryText } from './pill.ts'

const now = createNow()
const offline = $derived(isOffline(connection.link))
const canRetry = $derived(connection.link.kind === 'disconnected')
</script>

{#if offline}
  <div class="banner" role="alert">
    <span class="text">
      <span class="glyph" aria-hidden="true">✕</span>
      {offlineText(connection.link)}
      <span class="muted">· {retryText(connection.link, now.value)}</span>
    </span>
    <button type="button" class="retry" disabled={!canRetry} onclick={() => connection.retry()}>Retry</button>
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 1rem;
    background: color-mix(in srgb, var(--k-danger) 14%, var(--k-bg));
    border-bottom: 1px solid color-mix(in srgb, var(--k-danger) 45%, var(--k-bg));
    font-size: 0.9rem;
  }
  .glyph { color: var(--k-danger); font-family: var(--font-mono); margin-right: 0.35rem; }
  .muted { color: var(--k-text-muted); }
  .retry {
    font: inherit;
    padding: 0.25rem 0.8rem;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--k-text);
    cursor: pointer;
  }
  .retry:disabled { opacity: 0.5; cursor: default; }
</style>
