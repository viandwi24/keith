<script lang="ts">
import type { InlineNode } from './markdown-nodes.ts'

let { nodes }: { nodes: InlineNode[] } = $props()
</script>

{#each nodes as node}
  {#if node.t === 'bold'}<strong>{node.s}</strong>{:else if node.t === 'code'}<code>{node.s}</code>{:else if node.t === 'link'}{#if node.href !== undefined}<a href={node.href} target="_blank" rel="noopener noreferrer">{node.s}</a>{:else}{node.s}{/if}{:else}{node.s}{/if}
{/each}

<style>
  code {
    font-family: var(--font-mono);
    font-size: 0.9em;
    padding: 0.1em 0.35em;
    background: var(--surface-strong);
    border-radius: 0.3rem;
  }
</style>
