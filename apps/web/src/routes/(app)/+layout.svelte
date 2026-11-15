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
import { session } from '#lib/features/session/index.ts'
import { motion, Shell, theme } from '#lib/features/shell/index.ts'
import { StepUpDialog } from '#lib/features/stepup/index.ts'
import type { LayoutProps } from './$types'

let { children }: LayoutProps = $props()

onMount(() => {
  // listeners first, then the feed starts (it sends no history); the connection monitor starts the feed
  live.start()
  connection.start(() => session.expire())
  void privacy.check()
  approvals.start()
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
  <Shell>
    {@render children()}
    {#snippet inspector()}<Inspector />{/snippet}
  </Shell>
  <PrivacyNotice />
  <StepUpDialog />
  <CommandPalette />
{/if}
