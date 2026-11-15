<script lang="ts">
import { ConnectionPill } from '../connection/index.ts'
import { ElevatedPill } from '../identity/index.ts'
import { session } from '../session/index.ts'
import { stepUp } from '../stepup/index.ts'
import AvatarMenu from './AvatarMenu.svelte'
import { rail } from './rail.svelte.ts'

// the shortcut the palette answers to: ⌘K on a Mac, Ctrl+K elsewhere
const modKey = /Mac|iPhone|iPad/i.test(globalThis.navigator?.platform ?? '') ? '⌘' : 'Ctrl+'
</script>

<header class="top">
  <button
    type="button"
    class="toggle wide-only"
    aria-label={rail.collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
    aria-pressed={rail.collapsed}
    onclick={() => rail.toggle()}
  >
    ≡
  </button>
  <span class="mark"><span aria-hidden="true">✳</span> KEITH</span>
  <span class="spacer"></span>
  <button type="button" class="palette-btn" aria-label="Open the command palette" onclick={() => (rail.paletteOpen = true)}>
    <span aria-hidden="true">⌕</span><span class="hint">Search</span><kbd>{modKey}K</kbd>
  </button>
  <ElevatedPill elevatedUntil={Math.max(session.me?.elevatedUntil ?? 0, stepUp.elevatedUntil ?? 0) || null} />
  <ConnectionPill />
  <button
    type="button"
    class="toggle tablet-only"
    aria-label="Open the inspector"
    onclick={() => (rail.inspectorOpen = true)}
  >
    ▤
  </button>
  <AvatarMenu />
</header>

<style>
  .top {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--border);
  }
  .mark { font-weight: 700; letter-spacing: 0.14em; font-size: 0.95rem; }
  .mark span { color: var(--k-accent); font-family: var(--font-mono); }
  .spacer { flex: 1; }
  .toggle {
    font: inherit;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: var(--radius);
    border: 1px solid transparent;
    background: transparent;
    color: var(--k-text-muted);
    cursor: pointer;
  }
  .toggle:hover { background: var(--surface); color: var(--k-text); }
  .palette-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font: inherit;
    font-size: 0.85rem;
    padding: 0.3rem 0.6rem;
    color: var(--k-text-muted);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
  }
  .palette-btn:hover { background: var(--surface); color: var(--k-text); }
  .palette-btn kbd { font-family: var(--font-mono); font-size: 0.75rem; }
  .palette-btn .hint { display: none; }
  @media (min-width: 640px) { .palette-btn .hint { display: inline; } }
  .wide-only { display: none; }
  .tablet-only { display: none; }
  @media (min-width: 1100px) {
    .wide-only { display: inline-block; }
  }
  @media (min-width: 640px) and (max-width: 1099px) {
    .tablet-only { display: inline-block; }
  }
</style>
