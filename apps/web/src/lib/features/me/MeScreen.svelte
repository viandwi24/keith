<script lang="ts">
import { appBase, session } from '../session/index.ts'
import PersonaPanel from './PersonaPanel.svelte'
import StyleForm from './StyleForm.svelte'

const base = appBase()
const owner = $derived(session.me?.role === 'owner')
</script>

<svelte:head><title>Me · Keith</title></svelte:head>

<section class="k-page">
  <h1>Me</h1>
  <p class="k-sub">{session.me?.name ?? ''}{session.me?.username ? ` (${session.me.username})` : ''} · {session.me?.role ?? ''}</p>

  <h2>How Keith talks to you</h2>
  <StyleForm />

  {#if owner}
    <h2>Persona</h2>
    <PersonaPanel owner />
  {/if}

  <h2>Memory</h2>
  <p class="k-sub">Dreaming, the diary and a staged plan.</p>
  <a class="k-button link-button" href="{base}/me/memory">Open Memory</a>
</section>

<style>
  .link-button { display: inline-block; text-decoration: none; }
</style>
