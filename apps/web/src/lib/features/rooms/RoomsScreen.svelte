<script lang="ts">
import { goto } from '$app/navigation'
import { appBase, session } from '../session/index.ts'
import InviteNotice from './InviteNotice.svelte'
import { rooms } from './rooms.svelte.ts'
import {
  inviteesOf,
  matchesFilter,
  NO_ROOMS,
  ROOM_FILTERS,
  type RoomFilter,
  roomRowsOf,
} from './rooms-view.ts'

const base = appBase()
let filter = $state<RoomFilter>('all')
let people = $state('')
let name = $state('')
let starting = $state(false)

const rows = $derived(roomRowsOf(rooms.headers, session.me?.personId ?? '', rooms.now))
const shown = $derived(rows.filter((r) => matchesFilter(r, filter)))
const invitees = $derived(inviteesOf(people))

async function start(event: Event): Promise<void> {
  event.preventDefault()
  if (invitees.length === 0 || starting) return
  starting = true
  const id = await rooms.create(invitees, name.trim() === '' ? undefined : name.trim())
  starting = false
  if (id !== undefined) {
    people = ''
    name = ''
    await goto(`${base}/rooms/${encodeURIComponent(id)}`)
  }
}
</script>

<svelte:head><title>Rooms · Keith</title></svelte:head>

<section class="k-page">
  <h1>Rooms</h1>
  <p class="k-sub">Shared conversations with other people. Keith joins and answers when it is addressed.</p>

  {#if rooms.error !== undefined}<p class="k-note error" role="alert">{rooms.error}</p>{/if}

  {#if rooms.invites.length > 0}
    <h2>Invitations</h2>
    <div class="invites"><InviteNotice limit={rooms.invites.length} /></div>
  {/if}

  <h2>Your rooms</h2>
  <div class="k-toolbar" role="group" aria-label="Filter rooms">
    {#each ROOM_FILTERS as f (f.id)}
      <button type="button" class="k-chip" aria-pressed={filter === f.id} onclick={() => (filter = f.id)}>{f.label}</button>
    {/each}
  </div>

  {#if !rooms.loaded}
    <p class="k-muted">Loading…</p>
  {:else if rows.length === 0}
    <p class="k-muted">{NO_ROOMS}</p>
  {:else if shown.length === 0}
    <p class="k-muted">No rooms match this filter.</p>
  {:else}
    <div class="k-tablewrap">
      <table class="k-table">
        <thead><tr><th scope="col">Room</th><th scope="col">State</th><th scope="col">Started by</th><th scope="col">Members</th></tr></thead>
        <tbody>
          {#each shown as row (row.id)}
            <tr>
              <td><a href="{base}/rooms/{encodeURIComponent(row.id)}">{row.name}</a></td>
              <td><span class="k-badge {row.tone}">{row.word}</span>{#if row.expires !== undefined} <span class="k-muted exp">{row.expires}</span>{/if}</td>
              <td>{row.initiator}</td>
              <td class="members">{row.members}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <h2>Start a room</h2>
  <form class="start" onsubmit={start}>
    <div class="k-field">
      <label for="room-people">Invite (usernames, separated by spaces or commas)</label>
      <input id="room-people" class="k-input" type="text" autocomplete="off" placeholder="ana duta" bind:value={people} />
    </div>
    <div class="k-field">
      <label for="room-name">Name <span class="k-hint">(optional)</span></label>
      <input id="room-name" class="k-input" type="text" maxlength="80" bind:value={name} />
    </div>
    <button type="submit" class="k-button primary" disabled={invitees.length === 0 || starting}>{starting ? 'Starting…' : 'Start room'}</button>
  </form>
</section>

<style>
  .invites { display: grid; gap: 0.5rem; }
  .members { overflow-wrap: anywhere; }
  .exp { font-size: 0.8rem; }
  .start { max-width: 28rem; }
</style>
