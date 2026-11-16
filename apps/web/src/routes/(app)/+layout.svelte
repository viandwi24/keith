<script lang="ts">
import { onDestroy, onMount } from 'svelte'
import { approvals } from '#lib/features/approvals/index.ts'
import { frontChat } from '#lib/features/chat/index.ts'
import { connection } from '#lib/features/connection/index.ts'
import { PrivacyNotice, privacy } from '#lib/features/identity/index.ts'
import { Inspector } from '#lib/features/inspector/index.ts'
import { live } from '#lib/features/live/index.ts'
import { CommandPalette } from '#lib/features/palette/index.ts'
import { presence } from '#lib/features/presence/index.ts'
import { registerServiceWorker } from '#lib/features/push/index.ts'
import { rooms } from '#lib/features/rooms/index.ts'
import { appBase, session } from '#lib/features/session/index.ts'
import { motion, Shell, theme } from '#lib/features/shell/index.ts'
import { LEGACY_SCREENS, legacyRedirect } from '#lib/features/stage/index.ts'
import { StepUpDialog } from '#lib/features/stepup/index.ts'
import { workspace } from '#lib/features/workspace/index.ts'
import { goto } from '$app/navigation'
import { page } from '$app/state'
import type { LayoutProps } from './$types'

let { children }: LayoutProps = $props()
const base = appBase()

// redesign in progress: the old screens are off (their code is the backup) and their paths go to the stage
$effect(() => {
  const to = legacyRedirect(base, page.url.pathname)
  if (to !== undefined) void goto(to, { replaceState: true })
})

onMount(() => {
  // listeners first, then the feed starts (it sends no history); the connection monitor starts the feed
  live.start()
  connection.start(() => session.expire())
  void privacy.check()
  approvals.start()
  // the workspace document lives in the core (ADR-0037); the leading tab reports what it shows with its heartbeat
  workspace.start()
  presence.setView(() => workspace.view)
  presence.start()
  // the app shell is cached by the worker; push needs it too (scope /app/)
  void registerServiceWorker()
  const stopTheme = theme.watch()
  const stopMotion = motion.watch()
  return () => {
    stopTheme()
    stopMotion()
  }
})
// Keith reads what this screen shows at each turn: a switch between the orb, a desktop and the overview is reported at once
let reportedView = ''
$effect(() => {
  const view = JSON.stringify(workspace.view)
  if (view === reportedView) return
  reportedView = view
  presence.reportView()
})
// the front chat starts once the person is known (also after an error that kept them)
$effect(() => {
  if (session.me !== undefined) {
    frontChat.start()
    rooms.start()
  }
})
onDestroy(() => {
  presence.stop()
  frontChat.stop()
  rooms.stop()
  live.stop()
  connection.stop()
  privacy.reset()
  approvals.stop()
})
</script>

{#if session.status === 'signed-in'}
  {#if LEGACY_SCREENS}
    <Shell>
      {@render children()}
      {#snippet inspector()}<Inspector />{/snippet}
    </Shell>
    <CommandPalette />
  {:else if legacyRedirect(base, page.url.pathname) === undefined}
    {@render children()}
  {/if}
  <PrivacyNotice />
  <StepUpDialog />
{/if}
