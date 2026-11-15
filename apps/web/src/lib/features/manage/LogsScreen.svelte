<script lang="ts">
import { shortId } from '@keith/app-model/manage'
import { appBase, session } from '../session/index.ts'
import LogsCall from './LogsCall.svelte'
import LogsRaw from './LogsRaw.svelte'
import LogsSession from './LogsSession.svelte'
import LogsSessions from './LogsSessions.svelte'
import { type LogsRoute, logsHref, parseLogsRoute } from './logs-path.ts'
import ManageHeader from './ManageHeader.svelte'
import { canOpen } from './sections.ts'

let { rest }: { rest: string | undefined } = $props()

const base = appBase()
const route = $derived(parseLogsRoute(rest))
const allowed = $derived(canOpen(session.me, 'logs'))

type Crumb = { label: string; href: string }
/** The way down to the level on screen: each part before the last is a link back up. */
const crumbs = $derived.by<Crumb[]>(() => {
  const out: Crumb[] = [{ label: 'Sessions', href: logsHref(base, { level: 'sessions' }) }]
  if (route.level === 'invalid' || route.level === 'sessions') return out
  out.push({
    label: shortId(route.sessionId, 28),
    href: logsHref(base, { level: 'session', sessionId: route.sessionId }),
  })
  if (route.level === 'session') return out
  out.push({
    label: shortId(route.callId, 20),
    href: logsHref(base, { level: 'call', sessionId: route.sessionId, callId: route.callId }),
  })
  if (route.level === 'call') return out
  out.push({
    label: 'raw',
    href: logsHref(base, route satisfies Exclude<LogsRoute, { level: 'invalid' }>),
  })
  return out
})
</script>

<svelte:head><title>Logs · Keith</title></svelte:head>

<section class="k-page">
  <ManageHeader title="Logs" back={route.level === 'sessions'} />
  {#if !allowed}
    <p class="k-note warning" role="alert">Your role does not include Logs.</p>
  {:else if route.level === 'invalid'}
    <p class="k-note error" role="alert">There is no such level.</p>
    <a href={logsHref(base, { level: 'sessions' })}>‹ All sessions</a>
  {:else}
    <nav class="crumbs" aria-label="Logs level">
      <ol>
        {#each crumbs as crumb, at (crumb.href)}
          <li>
            {#if at === crumbs.length - 1}<span aria-current="page">{crumb.label}</span>{:else}<a href={crumb.href}>{crumb.label}</a>{/if}
          </li>
        {/each}
      </ol>
    </nav>
    {#if route.level === 'sessions'}
      <LogsSessions />
    {:else if route.level === 'session'}
      {#key route.sessionId}<LogsSession id={route.sessionId} />{/key}
    {:else if route.level === 'call'}
      {#key route.callId}<LogsCall sessionId={route.sessionId} callId={route.callId} />{/key}
    {:else}
      {#key route.callId}<LogsRaw callId={route.callId} />{/key}
    {/if}
  {/if}
</section>

<style>
  .crumbs { margin: 0 0 1rem; font-size: 0.85rem; }
  ol { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.25rem; }
  li + li::before { content: '›'; margin-right: 0.25rem; color: var(--k-text-muted); }
  li span { color: var(--k-text-muted); font-family: var(--font-mono); }
  li a { font-family: var(--font-mono); }
</style>
