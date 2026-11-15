<script lang="ts">
import CodeBlock from './CodeBlock.svelte'
import InlineText from './InlineText.svelte'
import MdList from './MdList.svelte'
import { markdownNodes } from './markdown-nodes.ts'

let { text }: { text: string } = $props()
const nodes = $derived(markdownNodes(text))
</script>

<div class="md">
  {#each nodes as node}
    {#if node.t === 'heading'}
      <svelte:element this={`h${Math.min(6, node.level + 1)}`}><InlineText nodes={node.inline} /></svelte:element>
    {:else if node.t === 'para'}
      <p>{#each node.lines as line, i}{#if i > 0}<br />{/if}<InlineText nodes={line} />{/each}</p>
    {:else if node.t === 'list'}
      <MdList list={node} />
    {:else if node.t === 'quote'}
      <blockquote>{#each node.lines as line, i}{#if i > 0}<br />{/if}<InlineText nodes={line} />{/each}</blockquote>
    {:else if node.t === 'code'}
      <CodeBlock text={node.text} lang={node.lang} />
    {:else if node.t === 'table'}
      <div class="table-wrap">
        <table>
          {#if node.head.length > 0}
            <thead><tr>{#each node.head as cell, c}<th style:text-align={node.align[c] ?? 'left'}><InlineText nodes={cell} /></th>{/each}</tr></thead>
          {/if}
          <tbody>
            {#each node.rows as row}
              <tr>{#each row as cell, c}<td style:text-align={node.align[c] ?? 'left'}><InlineText nodes={cell} /></td>{/each}</tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/each}
</div>

<style>
  .md { overflow-wrap: anywhere; }
  .md > :first-child { margin-top: 0; }
  .md > :last-child { margin-bottom: 0; }
  p { margin: 0.5rem 0; }
  .md :global(h2), .md :global(h3), .md :global(h4), .md :global(h5), .md :global(h6) { margin: 1rem 0 0.4rem; line-height: 1.3; }
  .md :global(h2) { font-size: 1.25rem; }
  .md :global(h3) { font-size: 1.1rem; }
  .md :global(h4), .md :global(h5), .md :global(h6) { font-size: 1rem; }
  blockquote { margin: 0.5rem 0; padding: 0.1rem 0.9rem; color: var(--k-text-muted); border-left: 3px solid var(--border); }
  .table-wrap { margin: 0.6rem 0; overflow-x: auto; }
  table { border-collapse: collapse; font-size: 0.9rem; }
  th, td { padding: 0.35rem 0.7rem; border: 1px solid var(--border); }
  th { background: var(--surface); font-weight: 600; }
</style>
