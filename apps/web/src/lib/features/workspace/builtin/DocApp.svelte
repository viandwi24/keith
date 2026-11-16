<script lang="ts">
import { Markdown } from '#lib/features/chat/index.ts'
import { docParams } from './params.ts'

// `web:doc { title?, text }`: Markdown drawn by the chat's renderer (it builds nodes, never HTML), so the text stays untrusted data.

let {
  params,
  windowId: _windowId,
}: { params: Record<string, unknown> | undefined; windowId?: string | undefined } = $props()
const doc = $derived(docParams(params))
</script>

{#if doc === undefined}
  <p class="note">No document to show.</p>
{:else}
  <article class="doc">
    {#if doc.title !== undefined}<h1>{doc.title}</h1>{/if}
    <Markdown text={doc.text} />
  </article>
{/if}

<style>
  .doc { height: 100%; min-height: 0; overflow: auto; padding: 12px 16px; box-sizing: border-box; color: var(--k-text); }
  h1 { margin: 0 0 8px; font-size: 15px; }
  .note { margin: 0; padding: 16px; color: var(--k-text-muted); font-size: 12px; }
</style>
