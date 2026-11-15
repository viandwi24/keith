<script lang="ts">
import { toasts } from './toasts.svelte.ts'
import { TOAST_GLYPH } from './toasts.ts'
</script>

<div class="stack" role="status" aria-live="polite">
  {#each toasts.items as toast (toast.id)}
    <div class="toast {toast.level}">
      <span class="glyph" aria-hidden="true">{TOAST_GLYPH[toast.level]}</span>
      <span class="text">{toast.text}{#if toast.link} · <a href={toast.link.href}>{toast.link.label}</a>{/if}</span>
    </div>
  {/each}
</div>

<style>
  .stack {
    position: fixed;
    top: 3.5rem;
    right: 1rem;
    z-index: 50;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-width: min(26rem, calc(100vw - 2rem));
    pointer-events: none;
  }
  .toast {
    display: flex;
    gap: 0.6rem;
    padding: 0.6rem 0.85rem;
    border-radius: var(--radius);
    background: var(--k-user-message);
    border: 1px solid var(--border);
    font-size: 0.9rem;
    overflow-wrap: anywhere;
    animation: in 150ms ease-out;
  }
  .toast:has(a) { pointer-events: auto; }
  a { color: var(--k-accent); }
  .glyph { font-family: var(--font-mono); font-weight: 700; color: var(--tone); }
  .info { --tone: var(--k-info); }
  .success { --tone: var(--k-success); }
  .warning { --tone: var(--k-warning); }
  .error { --tone: var(--k-danger); }
  @keyframes in { from { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .toast { animation: none; }
  }
</style>
