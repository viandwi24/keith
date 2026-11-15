<script lang="ts">
import { connection } from './connection.svelte.ts'
import { type Pill, pillOf } from './pill.ts'

const pill: Pill = $derived(pillOf(connection.link))
</script>

<span class="pill {pill.tone}" role="status" aria-label="connection: {pill.label}">
  <span class="glyph" aria-hidden="true">{pill.glyph}</span>
  <span class="label">{pill.label}</span>
</span>

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 0.8rem;
    color: var(--tone);
    background: var(--surface);
  }
  .muted { --tone: var(--k-text-muted); }
  .success { --tone: var(--k-success); }
  .warning { --tone: var(--k-warning); }
  .danger { --tone: var(--k-danger); }
  .glyph { font-family: var(--font-mono); }
  @media (max-width: 639px) {
    .label { display: none; }
  }
</style>
