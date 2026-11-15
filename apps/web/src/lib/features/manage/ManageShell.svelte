<script lang="ts">
import type { Snippet } from 'svelte'
import { page } from '$app/state'
import { appBase, session } from '../session/index.ts'
import { sectionHref, sectionsFor } from './sections.ts'

let { children }: { children: Snippet } = $props()

const base = appBase()
const sections = $derived(sectionsFor(session.me))
const active = (id: string): boolean => {
  const href = sectionHref(base, id)
  return page.url.pathname === href || page.url.pathname.startsWith(`${href}/`)
}
</script>

<div class="manage">
  <nav class="nav" aria-label="Manage sections">
    <a class="all" href="{base}/manage">Manage</a>
    <ul>
      {#each sections as s (s.id)}
        <li>
          <a href={sectionHref(base, s.id)} aria-current={active(s.id) ? 'page' : undefined}>{s.title}</a>
        </li>
      {/each}
    </ul>
  </nav>
  <div class="content">{@render children()}</div>
</div>

<style>
  .manage { display: block; }
  .nav { display: none; }
  .content { min-width: 0; }
  @media (min-width: 900px) {
    .manage { display: grid; grid-template-columns: 13rem minmax(0, 1fr); min-height: 100%; }
    .nav {
      display: block;
      padding: 1.25rem 0.75rem;
      border-right: 1px solid var(--border);
      position: sticky;
      top: 0;
      align-self: start;
      max-height: 100%;
      overflow-y: auto;
    }
    .all { display: block; padding: 0.4rem 0.6rem; margin-bottom: 0.5rem; color: var(--k-text-muted); font-size: 0.75rem; letter-spacing: 0.06em; text-transform: uppercase; text-decoration: none; }
    ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.1rem; }
    li a { display: block; padding: 0.4rem 0.6rem; border-radius: calc(var(--radius) - 2px); color: var(--k-text); text-decoration: none; font-size: 0.92rem; }
    li a:hover { background: var(--surface); }
    li a[aria-current='page'] { background: var(--surface-strong); color: var(--k-accent); font-weight: 600; }
  }
</style>
