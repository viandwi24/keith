<script lang="ts">
import { type ToolCall, taskFor, toolLineOf } from '@keith/app-model'
import { type Task } from '@keith/contracts'
import { appBase } from '../session/index.ts'
import { clippedValue, jsonText, toneColor } from './tone.ts'

let {
  call,
  tasks,
  now,
  loadFull,
}: {
  call: ToolCall
  tasks: readonly Task[]
  now: number
  loadFull: () => Promise<unknown>
} = $props()

const line = $derived(toolLineOf(call, tasks, now))
const task = $derived(call.name === 'agent' ? taskFor(call, tasks) : undefined)
const clipped = $derived(clippedValue(call.input) || clippedValue(call.output))
let loading = $state(false)

async function full(): Promise<void> {
  loading = true
  try {
    await loadFull()
  } finally {
    loading = false
  }
}
</script>

<details class="tool">
  <summary>
    <span class="glyph" style:color={toneColor(line.glyphTone ?? 'tool')} aria-hidden="true">{line.glyph}</span>
    <span class="label">{line.label}</span>
    {#if line.summary}<span class="summary">{line.summary}</span>{/if}
    {#if task !== undefined}<a class="chip" href={`${appBase()}/tasks/${encodeURIComponent(task.id)}`} title={task.description} onclick={(e) => e.stopPropagation()}>task · {task.status}</a>{/if}
    {#if line.state}
      <span class="state" style:color={toneColor(line.state.tone)}>
        {#if line.state.spinner}<span class="spin" aria-hidden="true"></span>{/if}{line.state.text}
      </span>
    {/if}
  </summary>
  <div class="body">
    {#if line.output && line.output.length > 0}
      <pre class="out">{line.output.join('\n')}{line.more ? `\n… ${line.more} more lines` : ''}</pre>
    {/if}
    <h4>Input</h4>
    <pre>{jsonText(call.input)}</pre>
    {#if call.output !== undefined}
      <h4>Output</h4>
      <pre>{jsonText(call.output)}</pre>
    {/if}
    {#if call.errorText}<h4>Error</h4><pre class="err">{call.errorText}</pre>{/if}
    {#if clipped}
      <button type="button" class="k-button" onclick={full} disabled={loading}>{loading ? 'Loading…' : 'Load full'}</button>
    {/if}
  </div>
</details>

<style>
  .tool { margin: 0.4rem 0; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); font-size: 0.88rem; }
  summary { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.7rem; cursor: pointer; list-style: none; min-width: 0; }
  summary::-webkit-details-marker { display: none; }
  .glyph { font-family: var(--font-mono); }
  .label { font-family: var(--font-mono); color: var(--k-tool); white-space: nowrap; }
  .summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--k-text-muted); font-family: var(--font-mono); }
  .state { margin-left: auto; white-space: nowrap; font-family: var(--font-mono); font-size: 0.82rem; }
  .chip { padding: 0.05rem 0.5rem; font-size: 0.75rem; color: var(--k-accent); border: 1px solid var(--border); border-radius: 999px; text-decoration: none; white-space: nowrap; }
  .body { padding: 0 0.7rem 0.7rem; }
  h4 { margin: 0.6rem 0 0.2rem; font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--k-text-muted); }
  pre { margin: 0; padding: 0.5rem 0.6rem; max-height: 18rem; overflow: auto; font-family: var(--font-mono); font-size: 0.8rem; background: var(--k-bg); border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px); white-space: pre-wrap; overflow-wrap: anywhere; }
  .err { color: var(--k-danger); }
  .spin { display: inline-block; width: 0.5rem; height: 0.5rem; margin-right: 0.4rem; border-radius: 50%; background: var(--k-accent); animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.25; } }
</style>
