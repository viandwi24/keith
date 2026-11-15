<script lang="ts">
import CopyButton from './CopyButton.svelte'

let { text, lang = '' }: { text: string; lang?: string } = $props()
</script>

<figure class="code">
  <figcaption><span>{lang}</span><CopyButton {text} /></figcaption>
  <pre><code>{text}</code></pre>
</figure>

<style>
  .code {
    margin: 0.6rem 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  figcaption {
    display: flex;
    justify-content: space-between;
    align-items: center;
    min-height: 1.9rem;
    padding: 0.2rem 0.5rem 0.2rem 0.75rem;
    font-size: 0.75rem;
    color: var(--k-text-muted);
    border-bottom: 1px solid var(--border);
  }
  pre { margin: 0; padding: 0.75rem; overflow-x: auto; font-family: var(--font-mono); font-size: 0.85rem; line-height: 1.45; }
</style>
