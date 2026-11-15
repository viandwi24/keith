<script lang="ts">
import { createNow } from '../connection/index.ts'
import { elevatedPillText } from './elevation.ts'

let { elevatedUntil }: { elevatedUntil: number | null | undefined } = $props()

const now = createNow()
const text = $derived(elevatedPillText(elevatedUntil, now.value))
</script>

{#if text !== undefined}
  <span class="elevated" title="This session is stepped up for sensitive actions">
    <span aria-hidden="true">▲</span>
    {text}
  </span>
{/if}

<style>
  .elevated {
    display: inline-flex;
    gap: 0.4rem;
    align-items: center;
    padding: 0.2rem 0.65rem;
    border-radius: 999px;
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
    color: var(--k-warning);
    border: 1px solid color-mix(in srgb, var(--k-warning) 55%, var(--k-bg));
    background: color-mix(in srgb, var(--k-warning) 10%, var(--k-bg));
  }
  @media (max-width: 639px) {
    .elevated { padding: 0.2rem 0.5rem; }
  }
</style>
