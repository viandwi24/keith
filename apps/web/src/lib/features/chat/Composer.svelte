<script lang="ts">
import { composerAction } from './composer-keys.ts'
import { completion, suggestions } from './slash.ts'

let {
  draft = $bindable(),
  busy,
  disabled,
  disabledReason,
  submit,
  stop,
}: {
  draft: string
  busy: boolean
  disabled: boolean
  disabledReason?: string
  submit: () => void
  stop: () => void
} = $props()

let field = $state<HTMLTextAreaElement>()
let index = $state(0)
let closed = $state(false)

const options = $derived(closed ? [] : suggestions(draft))
const selected = $derived(Math.min(index, Math.max(0, options.length - 1)))

$effect(() => {
  draft
  index = 0
  closed = false
})
// grow with the text, up to a few lines
$effect(() => {
  draft
  if (field === undefined) return
  field.style.height = 'auto'
  field.style.height = `${Math.min(field.scrollHeight, 200)}px`
})

function pick(name: string): void {
  draft = name
  field?.focus()
}

function onkeydown(event: KeyboardEvent): void {
  const action = composerAction(event, { menu: options.length > 0, busy })
  if (action === 'none' || action === 'newline') return
  event.preventDefault()
  if (action === 'send') {
    // Enter on the menu picks the highlighted command first, a second Enter runs it
    const chosen = options[selected]
    if (
      chosen !== undefined &&
      chosen.name !== draft.trim() &&
      completion(draft) === undefined &&
      options.length > 0
    )
      pick(chosen.name)
    else if (!disabled) submit()
  } else if (action === 'complete') {
    const chosen = options[selected]
    if (chosen !== undefined) pick(chosen.name)
  } else if (action === 'menu-down') index = (selected + 1) % options.length
  else if (action === 'menu-up') index = (selected - 1 + options.length) % options.length
  else if (action === 'close-menu') closed = true
  else if (action === 'stop') stop()
}
</script>

<div class="composer">
  {#if options.length > 0}
    <ul class="menu" role="listbox" aria-label="Commands">
      {#each options as option, i}
        <li role="option" aria-selected={i === selected}>
          <button type="button" class:active={i === selected} onmousedown={(e) => { e.preventDefault(); pick(option.name) }}>
            <code>{option.name}</code><span>{option.hint}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  <div class="box" class:off={disabled}>
    <textarea
      bind:this={field}
      bind:value={draft}
      {onkeydown}
      rows="1"
      placeholder={disabled ? (disabledReason ?? 'Not connected') : 'Message Keith   (Enter sends, Shift+Enter for a new line, / for commands)'}
      aria-label="Message"
      {disabled}
    ></textarea>
    {#if busy}
      <button type="button" class="k-button stop" onclick={stop} aria-label="Stop the turn">■ Stop</button>
    {:else}
      <button type="button" class="k-button primary" onclick={submit} disabled={disabled || draft.trim() === ''} aria-label="Send">Send</button>
    {/if}
  </div>
</div>

<style>
  .composer { position: relative; max-width: 760px; margin: 0 auto; width: 100%; padding: 0.5rem 1rem 0.75rem; }
  .box { display: flex; align-items: flex-end; gap: 0.5rem; padding: 0.4rem 0.4rem 0.4rem 0.75rem; background: var(--surface); border: 1px solid var(--border); border-radius: calc(var(--radius) * 1.5); }
  .box:focus-within { border-color: var(--k-accent); }
  .box.off { opacity: 0.6; }
  textarea { flex: 1; min-height: 1.5rem; max-height: 200px; resize: none; padding: 0.35rem 0; font: inherit; color: var(--k-text); background: none; border: none; outline: none; }
  textarea::placeholder { color: var(--k-text-muted); }
  .stop { color: var(--k-danger); }
  .menu { position: absolute; left: 1rem; right: 1rem; bottom: calc(100% - 0.4rem); margin: 0; padding: 0.3rem; list-style: none; max-height: 14rem; overflow-y: auto; background: var(--k-bg); border: 1px solid var(--border); border-radius: var(--radius); z-index: 5; }
  .menu button { display: flex; gap: 0.75rem; width: 100%; padding: 0.4rem 0.6rem; font: inherit; text-align: left; color: var(--k-text); background: none; border: none; border-radius: calc(var(--radius) - 2px); cursor: pointer; }
  .menu button.active, .menu button:hover { background: var(--surface-strong); }
  .menu code { font-family: var(--font-mono); color: var(--k-accent); white-space: nowrap; }
  .menu span { color: var(--k-text-muted); font-size: 0.85rem; }
  @media (max-width: 639px) { .composer { padding: 0.4rem 0.6rem 0.5rem; } }
</style>
