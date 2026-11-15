<script lang="ts">
import { appBase, session } from '../session/index.ts'
import { sectionHref, sectionsFor } from './sections.ts'

const WHAT: Record<string, string> = {
  overview: 'Who you are, the core, models, spend and what waits for you',
  people: 'Add, rename, suspend, set secrets and grants',
  groups: 'Who is in each group you share with',
  plugins: 'Built-in plugins and their status',
  reviews: 'What plugins hold for you to approve or deny',
  protocols: 'Reminders and protocols, proposals, limits',
  devices: 'Device logins and long-lived tokens',
  nodes: 'Paired nodes and their drivers',
  providers: 'Connections and the model of each role',
  persona: 'The persona text and its history',
  access: 'Local or remote, public URL, audit retention',
  succession: 'The heir, the window, the pause',
  budget: 'The monthly limit and each person’s cap',
  logs: 'Model calls: sessions, generations, raw JSON',
  privacy: 'What others did with your things',
  audit: 'The newest events, with filters',
}

const base = appBase()
const sections = $derived(sectionsFor(session.me))
</script>

<svelte:head><title>Manage · Keith</title></svelte:head>

<section class="k-page">
  <h1>Manage</h1>
  <p class="k-sub">{session.me?.role === 'owner' ? 'Everything you can change in this Keith.' : 'What your role lets you see and do.'}</p>
  <ul class="grid">
    {#each sections as s (s.id)}
      <li>
        <a class="card" href={sectionHref(base, s.id)}>
          <strong>{s.title}</strong>
          <span>{WHAT[s.id] ?? ''}</span>
        </a>
      </li>
    {/each}
  </ul>
</section>

<style>
  .grid { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.6rem; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); }
  .card {
    display: grid;
    gap: 0.2rem;
    height: 100%;
    padding: 0.8rem 0.9rem;
    color: var(--k-text);
    text-decoration: none;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .card:hover { border-color: var(--k-text-muted); }
  strong { font-weight: 600; }
  span { color: var(--k-text-muted); font-size: 0.85rem; }
</style>
