<script lang="ts">
import type { SummaryCard } from '../live/index.ts'
import { appBase } from '../session/index.ts'

let { cards }: { cards: readonly SummaryCard[] } = $props()
const base = appBase()
</script>

<ul class="cards">
  {#each cards as card (card.id)}
    <li>
      <a class="card {card.tone ?? ''}" href="{base}{card.path}">
        <span class="label">{card.label}</span>
        <strong class="value">{card.value}</strong>
        <span class="detail">{card.detail}</span>
      </a>
    </li>
  {/each}
</ul>

<style>
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
    gap: 0.75rem;
    width: 100%;
    max-width: 52rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .card {
    display: grid;
    gap: 0.15rem;
    height: 100%;
    padding: 0.75rem 0.9rem;
    color: var(--k-text);
    text-decoration: none;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .card:hover { border-color: var(--k-text-muted); }
  .card.warning { border-color: var(--k-warning); }
  .card.danger { border-color: var(--k-danger); }
  .label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--k-text-muted); }
  .value { font-size: 1.1rem; font-weight: 600; }
  .warning .value { color: var(--k-warning); }
  .danger .value { color: var(--k-danger); }
  .detail { font-size: 0.8rem; color: var(--k-text-muted); }
</style>
