<script lang="ts">
import InlineText from './InlineText.svelte'
import type { ListNode } from './markdown-nodes.ts'

let { list }: { list: ListNode } = $props()
</script>

{#snippet branch(node: ListNode)}
  <svelte:element this={node.ordered ? 'ol' : 'ul'}>
    {#each node.items as item}
      <li>
        <InlineText nodes={item.inline} />
        {#each item.children as child}{@render branch(child)}{/each}
      </li>
    {/each}
  </svelte:element>
{/snippet}

{@render branch(list)}

<style>
  :global(.md) ul, :global(.md) ol { margin: 0.3rem 0; padding-left: 1.4rem; }
  li { margin: 0.1rem 0; }
</style>
