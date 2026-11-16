<script lang="ts">
import { TerminalView } from '#lib/features/apps/index.ts'
import { tuiView } from './params.ts'

// `web:tui { view }`: a plugin terminal view (`<plugin>.<view>`, docs/specs/plugin-views.md) inside a window, drawn by the Apps
// screen's terminal view, embedded (no back links, no page title); the core decides whether this person may open it.

let {
  params,
  windowId: _windowId,
}: { params: Record<string, unknown> | undefined; windowId?: string | undefined } = $props()
const view = $derived(tuiView(params))
</script>

{#if view === undefined}
  <p class="note">No terminal view to show.</p>
{:else}
  <div class="tui">{#key view}<TerminalView viewId={view} label={view} embedded />{/key}</div>
{/if}

<style>
  .tui { height: 100%; min-height: 0; display: flex; flex-direction: column; }
  .tui > :global(*) { flex: 1; min-height: 0; }
  .note { margin: 0; padding: 16px; color: var(--k-text-muted); font-size: 12px; }
</style>
