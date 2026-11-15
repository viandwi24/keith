<script lang="ts">
import { type ChatItem, type HistoryRow, historyRowsOf, toItems } from '@keith/app-model'
import { CHAT_CLIP, frontSessionOf } from '@keith/client/browser'
import { onMount } from 'svelte'
import { page } from '$app/state'
import { appBase, getClient, session } from '../session/index.ts'
import ConversationView from './ConversationView.svelte'

const base = appBase()
const client = getClient()
const personId = session.me?.personId ?? ''

let rows = $state<HistoryRow[] | undefined>(undefined)
let error = $state<string | undefined>(undefined)
let items = $state<ChatItem[]>([])
let loaded = $state(false)
let before = $state<string | undefined>(undefined)
let loadingOlder = $state(false)
let newest = $state(0)

const selected = $derived.by(() => {
  const g = page.url.searchParams.get('g')
  return g === null || !/^\d+$/.test(g) ? undefined : Number(g)
})

onMount(() => {
  client.chatContext.generations().then(
    (list) => {
      rows = historyRowsOf(list)
      newest = list.at(-1)?.generation ?? 0
    },
    (e: unknown) => {
      error = e instanceof Error ? e.message : String(e)
    },
  )
})

async function read(generation: number, cursor?: string): Promise<number> {
  const id = frontSessionOf(personId, generation)
  try {
    const result = await client.harness.sessions.messages(id, {
      limit: 50,
      clip: CHAT_CLIP,
      ...(cursor === undefined ? {} : { before: cursor }),
    })
    const next = toItems(result.messages)
    items = cursor === undefined ? next : [...toItems(result.messages), ...items]
    before = result.nextBefore
    return result.messages.length
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
    return 0
  } finally {
    loaded = true
  }
}

$effect(() => {
  if (selected === undefined) return
  items = []
  loaded = false
  before = undefined
  void read(selected)
})

async function older(): Promise<number> {
  if (selected === undefined || before === undefined || loadingOlder) return 0
  loadingOlder = true
  try {
    return await read(selected, before)
  } finally {
    loadingOlder = false
  }
}
</script>

<svelte:head><title>History · Keith</title></svelte:head>

<div class="history">
  <header>
    <a href={selected === undefined ? `${base}/chat` : `${base}/chat/history`}>← {selected === undefined ? 'Chat' : 'History'}</a>
    <h1>{selected === undefined ? 'History' : selected === 0 ? 'First context' : `Context ${selected}`}</h1>
  </header>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if selected === undefined}
    {#if rows === undefined && error === undefined}
      <p class="muted">reading…</p>
    {:else if rows?.length === 0}
      <p class="muted">No earlier conversations yet.</p>
    {:else}
      <ul class="list">
        {#each rows ?? [] as row (row.generation)}
          <li>
            <a href={row.generation === newest ? `${base}/chat` : `${base}/chat/history?g=${row.generation}`}>
              <strong>{row.generation === 0 ? 'First context' : `Context ${row.generation}`}</strong>
              <span>{row.messages}{row.compacted ? ` · ${row.compacted}` : ''}</span>
              <span class="muted">{row.started} · {row.ended}</span>
            </a>
          </li>
        {/each}
      </ul>
      <p class="muted">Read only. Your earlier messages stay with you; nothing here changes.</p>
    {/if}
  {:else}
    <ConversationView
      {items}
      tasks={[]}
      now={0}
      phase="idle"
      busy={false}
      sends={0}
      {loaded}
      hasOlder={before !== undefined}
      {loadingOlder}
      settled={{}}
      pending={undefined}
      dreaming={undefined}
      showStart={false}
      generation={selected}
      loadOlder={older}
      loadFull={async () => undefined}
      answer={() => {}}
      readOnly
    />
  {/if}
</div>

<style>
  .history { display: flex; flex-direction: column; height: 100%; min-height: 0; max-width: 760px; margin: 0 auto; padding: 1rem; }
  header { display: flex; align-items: baseline; gap: 1rem; margin-bottom: 0.75rem; }
  h1 { margin: 0; font-size: 1.3rem; font-weight: 600; }
  .list { margin: 0 0 1rem; padding: 0; list-style: none; display: grid; gap: 0.5rem; }
  .list a { display: grid; gap: 0.1rem; padding: 0.7rem 0.9rem; color: var(--k-text); text-decoration: none; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
  .list a:hover { border-color: var(--k-accent); }
  .muted { color: var(--k-text-muted); font-size: 0.9rem; }
  .error { color: var(--k-danger); }
</style>
