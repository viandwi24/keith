<script lang="ts">
import { mediaParams } from './params.ts'

// `web:media { url, kind, caption? }`: an https image, video or audio in the native element. No autoplay: sound comes only after
// the person presses play.

let {
  params,
  windowId: _windowId,
}: { params: Record<string, unknown> | undefined; windowId?: string | undefined } = $props()
const media = $derived(mediaParams(params))
</script>

{#if media.ok}
  <figure class="media">
    <div class="stage">
      {#if media.kind === 'image'}
        <img src={media.url} alt={media.caption ?? media.domain} referrerpolicy="no-referrer" />
      {:else if media.kind === 'video'}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video src={media.url} controls preload="metadata" playsinline></video>
      {:else}
        <audio src={media.url} controls preload="metadata"></audio>
      {/if}
    </div>
    <figcaption>{media.caption ?? ''} <span class="domain">{media.domain}</span></figcaption>
  </figure>
{:else}
  <p class="note">{media.reason === 'not-https' ? 'Only https files' : 'No media to show.'}</p>
{/if}

<style>
  .media { margin: 0; height: 100%; min-height: 0; display: flex; flex-direction: column; }
  .stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; }
  img, video { max-width: 100%; max-height: 100%; object-fit: contain; }
  audio { width: 90%; }
  figcaption { padding: 4px 8px; font-size: 11px; color: var(--k-text); }
  .domain { color: var(--k-text-muted); }
  .note { margin: 0; padding: 16px; color: var(--k-text-muted); font-size: 12px; }
</style>
