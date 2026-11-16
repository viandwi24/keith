<script lang="ts">
import { InboxScreen } from '#lib/features/approvals/index.ts'
import { BrainScreen } from '#lib/features/brain/index.ts'
import { BudgetScreen } from '#lib/features/budget/index.ts'
import { ChatScreen } from '#lib/features/chat/index.ts'
import { MemoryScreen } from '#lib/features/me/index.ts'
import { NodesScreen } from '#lib/features/nodes/index.ts'
import { RoomsScreen } from '#lib/features/rooms/index.ts'
import { TasksScreen } from '#lib/features/tasks/index.ts'
import { appOf, builtinName } from './apps.ts'
import BrowserApp from './builtin/BrowserApp.svelte'
import DocApp from './builtin/DocApp.svelte'
import MediaApp from './builtin/MediaApp.svelte'
import TuiApp from './builtin/TuiApp.svelte'
import PluginFrame from './PluginFrame.svelte'
import { workspace } from './workspace.svelte.ts'

// One window's app (`apps.ts`): a built-in app of the plugin `web` by its name (an old screen, or an app that reads the window's
// params), or a plugin page in a sandboxed frame (`PluginFrame`).

let {
  app,
  params,
  windowId,
}: {
  app: string
  /** The window's params (`window.setParams`); read by the apps that take any. */
  params?: Record<string, unknown> | undefined
  windowId?: string | undefined
} = $props()

const SCREENS = {
  chat: ChatScreen,
  tasks: TasksScreen,
  inbox: InboxScreen,
  nodes: NodesScreen,
  memory: MemoryScreen,
  rooms: RoomsScreen,
  budget: BudgetScreen,
  brain: BrainScreen,
} as const
const WITH_PARAMS = { browser: BrowserApp, doc: DocApp, media: MediaApp, tui: TuiApp } as const

const known = $derived(appOf(app, workspace.apps))
const name = $derived(builtinName(app, known))
const Screen = $derived(name === undefined ? undefined : SCREENS[name as keyof typeof SCREENS])
const ParamsApp = $derived(
  name === undefined ? undefined : WITH_PARAMS[name as keyof typeof WITH_PARAMS],
)
const plugin = $derived(known !== undefined && 'url' in known.entry ? known : undefined)
</script>

{#if Screen}
  <div class="app"><Screen /></div>
{:else if ParamsApp}
  <div class="app"><ParamsApp {params} {windowId} /></div>
{:else if plugin}
  <div class="app"><PluginFrame app={plugin} {params} {windowId} /></div>
{:else}
  <p class="missing">This app is not available in this client.</p>
{/if}

<style>
  .app { height: 100%; min-height: 0; display: flex; flex-direction: column; }
  .app > :global(*) { flex: 1; min-height: 0; }
  .missing { margin: 0; padding: 16px; color: var(--k-text-muted); font-size: 12px; }
</style>
