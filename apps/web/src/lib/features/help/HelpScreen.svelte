<script lang="ts">
import { appBase } from '../session/index.ts'
import { COMMANDS, DOC_LINKS, ON_A_PAGE, SCREENS, SHORTCUTS } from './help-content.ts'

const base = appBase()
const href = (path: string): string => (path === '/' ? `${base}/` : `${base}${path}`)
</script>

<svelte:head><title>Help · Keith</title></svelte:head>

<section class="k-page">
  <h1>Help</h1>
  <p class="k-sub">Keys, commands and what each screen is for.</p>

  <h2>Keyboard shortcuts</h2>
  <div class="k-tablewrap">
    <table class="k-table">
      <thead><tr><th scope="col">Keys</th><th scope="col">What it does</th><th scope="col">Where</th></tr></thead>
      <tbody>
        {#each SHORTCUTS as s}
          <tr><td class="mono keys">{s.keys}</td><td>{s.action}</td><td class="k-muted">{s.where}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  <p class="k-hint">Only the palette shortcut works on every page; the other keys act only where they are listed, so typing never answers an approval.</p>

  <h2>Slash commands</h2>
  <div class="k-tablewrap">
    <table class="k-table">
      <thead><tr><th scope="col">Command</th><th scope="col">What it does</th></tr></thead>
      <tbody>
        {#each COMMANDS as c}
          <tr><td class="mono">{c.name}</td><td>{c.hint}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  <p class="k-hint">Terminal commands that have a page here:
    {#each ON_A_PAGE as row, i}{#if i > 0}, {/if}<span class="k-mono">{row.command}</span> is <a href={href(row.path)}>{row.page}</a>{/each}.</p>

  <h2>The screens</h2>
  <ul class="screens">
    {#each SCREENS as s}
      <li><a href={href(s.path)}>{s.title}</a> <span class="k-muted">{s.does}</span></li>
    {/each}
  </ul>

  <h2>Documentation</h2>
  <ul class="screens">
    {#each DOC_LINKS as l}
      <li><a href={l.href} target="_blank" rel="noopener noreferrer">{l.title}</a> <span class="k-muted">{l.about}</span></li>
    {/each}
  </ul>
</section>

<style>
  .keys { white-space: nowrap; }
  .screens { margin: 0; padding: 0; list-style: none; display: grid; gap: 0.5rem; }
</style>
