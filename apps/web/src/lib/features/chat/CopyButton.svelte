<script lang="ts">
let { text, label = 'Copy' }: { text: string; label?: string } = $props()
let done = $state(false)

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    done = true
    setTimeout(() => {
      done = false
    }, 1500)
  } catch {
    // no clipboard permission (plain HTTP, a private window): nothing to do
  }
}
</script>

<button type="button" class="copy" onclick={copy} aria-label={label}>{done ? 'Copied' : label}</button>

<style>
  .copy {
    font: inherit;
    font-size: 0.75rem;
    padding: 0.15rem 0.5rem;
    color: var(--k-text-muted);
    background: var(--k-bg);
    border: 1px solid var(--border);
    border-radius: 0.3rem;
    cursor: pointer;
  }
  .copy:hover { color: var(--k-text); }
</style>
