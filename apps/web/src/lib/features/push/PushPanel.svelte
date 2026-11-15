<script lang="ts">
import { onMount } from 'svelte'
import { ConfirmButton } from '#lib/features/confirm/index.ts'
import { devicePush } from './device-push.svelte.ts'
import { AVAILABILITY_TEXT, PREVIEW_NOTE, toggleEnabled, toggleLabel } from './push-model.ts'

onMount(() => void devicePush.init())

const input = $derived({
  availability: devicePush.availability,
  subscribed: devicePush.subscribed,
  busy: devicePush.busy,
})
const reason = $derived(
  devicePush.availability === 'ready' ? undefined : AVAILABILITY_TEXT[devicePush.availability],
)
</script>

<h2>Notifications on this device</h2>
<p class="k-sub">Keith can reach you here when this page is closed, with a push notification. It tells you something is waiting; the message itself stays in the chat.</p>

<div class="toggle">
  <button class="k-button" class:primary={!devicePush.subscribed} type="button" disabled={!toggleEnabled(input)} aria-pressed={devicePush.subscribed} onclick={() => void devicePush.toggle()}>
    {toggleLabel(input)}
  </button>
  <span class="k-badge {devicePush.subscribed ? 'success' : ''}">{devicePush.subscribed ? 'on' : 'off'}</span>
</div>
{#if reason !== undefined && !devicePush.subscribed}<p class="k-note warning" role="note">{reason}</p>{/if}
<p class="k-hint">Push needs HTTPS or localhost. On iPhone and iPad it needs Keith added to the Home Screen (iOS 16.4 or later).</p>

<h3>Message text in notifications</h3>
<label class="check">
  <input type="checkbox" checked={devicePush.preview} onchange={(e) => void devicePush.setPreview(e.currentTarget.checked)} />
  Show message text in notifications
</label>
<p class="k-hint">{PREVIEW_NOTE}</p>

<h3>Your devices</h3>
{#if devicePush.error !== undefined}
  <p class="k-note error" role="alert">{devicePush.error}</p>
{:else if !devicePush.loaded}
  <p class="k-muted">Reading your devices…</p>
{:else if devicePush.rows.length === 0}
  <p class="k-muted">No device gets push notifications yet.</p>
{:else}
  <ul class="devices">
    {#each devicePush.rows as row (row.id)}
      <li>
        <div>
          <strong>{row.label}</strong>
          {#if row.here}<span class="k-badge info">this device</span>{/if}
          <div class="k-muted meta" class:warn={row.warn}>{row.added} · {row.health}</div>
        </div>
        <ConfirmButton label="Remove" question="Remove this device?" yes="Remove" danger onconfirm={() => void devicePush.remove(row.id)} />
      </li>
    {/each}
  </ul>
{/if}

<style>
  .toggle { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .check { display: flex; align-items: center; gap: 0.5rem; }
  .devices { list-style: none; margin: 0.5rem 0 0; padding: 0; display: grid; gap: 0.5rem; max-width: 40rem; }
  .devices li { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 0.6rem 0.8rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
  .meta { font-size: 0.85rem; }
  .meta.warn { color: var(--k-warning); }
  h3 { font-size: 1rem; margin: 1.2rem 0 0.4rem; }
</style>
