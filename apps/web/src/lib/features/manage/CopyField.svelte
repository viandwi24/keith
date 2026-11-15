<script lang="ts">
let { text, label = 'Copy' }: { text: string; label?: string } = $props()
let done = $state(false)
let timer: ReturnType<typeof setTimeout> | undefined

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    done = true
    clearTimeout(timer)
    timer = setTimeout(() => {
      done = false
    }, 1500)
  } catch {
    // no clipboard permission (plain HTTP, a private window): the text is selectable
  }
}
</script>

<button type="button" class="copy" onclick={copy} aria-label={label}>{done ? 'Copied' : label}</button>

<style>
  .copy {
    font: inherit;
    font-size: 0.8rem;
    padding: 0.25rem 0.7rem;
    color: var(--k-text);
    background: var(--surface-strong);
    border: 1px solid var(--border);
    border-radius: 0.3rem;
    cursor: pointer;
  }
  .copy:hover { border-color: var(--k-text-muted); }
</style>
