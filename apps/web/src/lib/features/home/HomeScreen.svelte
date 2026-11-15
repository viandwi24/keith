<script lang="ts">
import { SUBTITLE_HOLD_MS } from '@keith/app-model'
import { approvals } from '../approvals/index.ts'
import { frontChat } from '../chat/index.ts'
import { connection } from '../connection/index.ts'
import { live, summaryCards } from '../live/index.ts'
import { InviteNotice, rooms } from '../rooms/index.ts'
import { appBase, session } from '../session/index.ts'
import { captionOf } from './caption.ts'
import OrbCanvas from './OrbCanvas.svelte'
import { orbState } from './orb-state.svelte.ts'
import QuickAsk from './QuickAsk.svelte'
import Subtitle from './Subtitle.svelte'
import SummaryCards from './SummaryCards.svelte'
import { latestReply, subtitleOf } from './subtitle.ts'
import TraceCanvas from './TraceCanvas.svelte'

const base = appBase()
const ctl = $derived(frontChat.ctl)

// the orb fills the height Home leaves it, within sensible bounds
let area = $state({ w: 600, h: 420 })
const orbSize = $derived(Math.max(160, Math.min(420, area.w - 32, area.h)))

// the subtitle: the words of the latest reply while it streams, held for a while after the turn
const raw = $derived(ctl === undefined ? '' : latestReply(ctl.items))
const busy = $derived(ctl?.busy ?? false)
let baseline = $state<string | undefined>(undefined)
let held = $state(false)
$effect(() => {
  // the reply that was there when Home opened is not new
  if (baseline === undefined && ctl?.loaded) baseline = raw
})
$effect(() => {
  raw
  held = false
  if (busy || raw === '') return undefined
  const timer = setTimeout(() => (held = true), SUBTITLE_HOLD_MS)
  return () => clearTimeout(timer)
})
const words = $derived(
  subtitleOf({
    raw,
    baseline: baseline ?? raw,
    busy,
    idleMs: held ? SUBTITLE_HOLD_MS : 0,
  }),
)

const caption = $derived(
  captionOf({
    link: connection.link.kind,
    approvals: approvals.answerable.length,
    dreaming: live.dreaming,
    busy,
    room: rooms.banner,
  }),
)
const cards = $derived(
  summaryCards({
    tasks: live.tasks,
    nodes: live.nodes,
    budget: live.budget,
    approvals: approvals.answerable.length,
  }),
)
</script>

<svelte:head><title>Keith</title></svelte:head>

<section class="home">
  <header class="greeting">Hello, {session.me?.name ?? 'there'}</header>
  <div class="stage" bind:clientWidth={area.w} bind:clientHeight={area.h}>
    <OrbCanvas mode={orbState.mode} size={orbSize} />
  </div>
  <div class="trace"><TraceCanvas height={48} /></div>
  <div class="slot">
    <Subtitle text={words} />
    <div class="caption" aria-live="polite">
      {#if caption !== undefined && words === ''}
        {#each caption.rows as row}
          {#if caption.path !== undefined && row === caption.rows[0]}
            <a class="row {row.tone}" href="{base}{caption.path}">{row.text}</a>
          {:else}
            <span class="row {row.tone}">{row.text}</span>
          {/if}
        {/each}
      {/if}
    </div>
  </div>
  <InviteNotice />
  <QuickAsk />
  <SummaryCards {cards} />
</section>

<style>
  .home {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    min-height: 100%;
    padding: 1rem 1.25rem 2rem;
  }
  .greeting { align-self: flex-start; color: var(--k-text-muted); font-size: 0.9rem; }
  .stage { flex: 1 1 14rem; display: grid; place-items: center; width: 100%; min-height: 12rem; max-height: 28rem; }
  .trace { width: 100%; max-width: 40rem; }
  .slot { display: grid; gap: 0.25rem; justify-items: center; width: 100%; }
  .caption { display: grid; justify-items: center; min-height: 1.5rem; font-size: 0.9rem; }
  .row.danger { color: var(--k-danger); }
  .row.warning { color: var(--k-warning); }
  .row.accent { color: var(--k-accent); }
  .row.muted { color: var(--k-text-muted); }
</style>
