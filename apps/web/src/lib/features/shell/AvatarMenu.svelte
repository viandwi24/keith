<script lang="ts">
import { DropdownMenu } from 'bits-ui'
import { onMount } from 'svelte'
import { goto } from '$app/navigation'
import { initialsOf } from '../identity/index.ts'
import { notifications } from '../presence/index.ts'
import { devicePush } from '../push/index.ts'
import { toggleEnabled, toggleLabel } from '../push/push-model.ts'
import { appBase, loginUrl, session } from '../session/index.ts'
import { toasts } from '../toasts/index.ts'
import { motion } from './motion.svelte.ts'
import { theme } from './theme.svelte.ts'
import { THEME_MODES } from './theme.ts'

const me = $derived(session.me)

async function signOut(): Promise<void> {
  await session.signOut()
  toasts.push('signed out', { level: 'info' })
  await goto(loginUrl(base, `${base}/`), { replaceState: true })
}
const base = appBase()
const pushInput = $derived({
  availability: devicePush.availability,
  subscribed: devicePush.subscribed,
  busy: devicePush.busy,
})
onMount(() => void devicePush.init())
</script>

{#if me !== undefined}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger class="avatar" aria-label="Account menu for {me.name}">
      {initialsOf(me.name)}
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content class="k-menu" align="end" sideOffset={8}>
        <div class="k-menu-head">
          <strong>{me.name}</strong>
          <span>{me.role}{me.username === null ? '' : ` · ${me.username}`}</span>
        </div>
        <DropdownMenu.Separator class="k-menu-sep" />
        <DropdownMenu.Group>
          <DropdownMenu.GroupHeading class="k-menu-label">Theme</DropdownMenu.GroupHeading>
          {#each THEME_MODES as option (option)}
            <DropdownMenu.Item class="k-menu-item" onSelect={() => theme.set(option)}>
              <span class="k-menu-check" aria-hidden="true">{theme.mode === option ? '✓' : ''}</span>
              {option}
            </DropdownMenu.Item>
          {/each}
        </DropdownMenu.Group>
        <DropdownMenu.Separator class="k-menu-sep" />
        <DropdownMenu.Group>
          <DropdownMenu.GroupHeading class="k-menu-label">Motion and alerts</DropdownMenu.GroupHeading>
          <DropdownMenu.Item class="k-menu-item" onSelect={() => motion.setStill(!motion.setting)}>
            <span class="k-menu-check" aria-hidden="true">{motion.setting ? '✓' : ''}</span>
            Still orb
          </DropdownMenu.Item>
          <DropdownMenu.Item class="k-menu-item" disabled={!notifications.enabled && !notifications.optedIn} onSelect={() => void notifications.toggle()}>
            <span class="k-menu-check" aria-hidden="true">{notifications.optedIn ? '✓' : ''}</span>
            {notifications.label}
          </DropdownMenu.Item>
          <DropdownMenu.Item class="k-menu-item" disabled={!toggleEnabled(pushInput)} onSelect={() => void devicePush.toggle()}>
            <span class="k-menu-check" aria-hidden="true">{devicePush.subscribed ? '✓' : ''}</span>
            {toggleLabel(pushInput)}
          </DropdownMenu.Item>
        </DropdownMenu.Group>
        <DropdownMenu.Separator class="k-menu-sep" />
        <DropdownMenu.Item class="k-menu-item" onSelect={signOut}>Sign out</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{/if}
