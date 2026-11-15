<script lang="ts">
import { goto } from '$app/navigation'
import { appBase } from '../session/index.ts'
import { rooms } from './rooms.svelte.ts'
import { expiryText } from './rooms-view.ts'

// The invitation notice (Home and the Rooms page): who invites, accept or decline. One notice per open invitation.
let { limit = 1 }: { limit?: number } = $props()
const base = appBase()
const shown = $derived(rooms.invites.slice(0, limit))
const more = $derived(rooms.invites.length - shown.length)

async function accept(roomId: string): Promise<void> {
  if (await rooms.accept(roomId)) await goto(`${base}/rooms/${encodeURIComponent(roomId)}`)
}
</script>

{#each shown as invite (invite.roomId)}
  <div class="invite" role="group" aria-label="Room invitation">
    <span class="text"><strong>{invite.initiator.name}</strong> invites you to a room with Keith: <em>{invite.roomName}</em> <span class="k-muted">({expiryText(invite.expiresAt, rooms.now)})</span></span>
    <span class="buttons">
      <button type="button" class="k-button primary" disabled={rooms.busy.includes(invite.roomId)} onclick={() => accept(invite.roomId)}>Accept</button>
      <button type="button" class="k-button" disabled={rooms.busy.includes(invite.roomId)} onclick={() => rooms.decline(invite.roomId)}>Decline</button>
    </span>
  </div>
{/each}
{#if more > 0}<a class="more" href="{base}/rooms">{more} more {more === 1 ? 'invitation' : 'invitations'}</a>{/if}

<style>
  .invite { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.6rem 1rem; width: 100%; max-width: 40rem; padding: 0.6rem 0.9rem; background: var(--surface); border: 1px solid var(--k-warning); border-radius: var(--radius); font-size: 0.92rem; }
  .text { overflow-wrap: anywhere; }
  .buttons { display: flex; gap: 0.5rem; }
  .buttons :global(.k-button) { padding: 0.3rem 0.8rem; font-size: 0.85rem; }
  .more { font-size: 0.85rem; }
</style>
