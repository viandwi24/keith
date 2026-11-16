<script lang="ts">
import { VOICE_ORB_PALETTE } from '@keith/ui/orb'
import { fade } from 'svelte/transition'
import { orbState } from '../home/index.ts'
import { motion } from '../shell/index.ts'
import {
  Desktop,
  Dock,
  keyAction,
  NARROW_WIDTH,
  Overview,
  PhoneDesktops,
  workspace,
} from '../workspace/index.ts'
import BrainPanel from './BrainPanel.svelte'
import { backdrop, float } from './float.ts'
import VoiceOrb from './VoiceOrb.svelte'
import { orbSizeFor } from './voice-orb-draw.ts'

// The new front page (redesign in progress), in two layers. Layer 0 is the background: near black, the voice orb in the middle of
// the screen and the wordmark under it; it never scrolls and takes no input. Above it the HUD panels float in a left and a right
// column (the brain trace first). No rail, top bar or tab bar.
// The workspace (ADR-0037) floats over this page: in workspace and overview mode the orb stays in the background behind a dimmed,
// blurred backdrop, and the desktop comes in over it (`float.ts`); the HUD and the way in fade out. Back to ambient, it leaves the
// same way and the orb is in front again.

/** From this width the panels float in two side columns; below it they stack in one column that scrolls over the orb. */
const SIDES_MIN_WIDTH = 900

let width = $state(0)
let height = $state(0)
const sides = $derived(width >= SIDES_MIN_WIDTH)
const size = $derived(orbSizeFor(width, height))
const p = VOICE_ORB_PALETTE
const DOCK_ORB = 36
const phone = $derived(width > 0 && width < NARROW_WIDTH)

/** The workspace shortcuts (`keys.ts`) work on the whole stage, ambient included. */
function onkey(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null
  const editable =
    target !== null &&
    (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
  const action = keyAction({
    code: e.code,
    altKey: e.altKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    shiftKey: e.shiftKey,
    editable,
  })
  if (action !== undefined && workspace.runKey(action)) e.preventDefault()
}
const windows = $derived(workspace.doc.desktops.reduce((n, d) => n + d.windows.length, 0))
const ambient = $derived(workspace.mode === 'ambient')
const reduced = $derived(motion.reduced)
</script>

<svelte:window onkeydown={onkey} />

{#snippet dockOrb()}
  <VoiceOrb mode={orbState.mode} size={DOCK_ORB} />
{/snippet}

<main
  class="stage"
  class:sides
  bind:clientWidth={width}
  bind:clientHeight={height}
  style:--stage-bg={p.background}
  style:--stage-centre={p.backgroundCentre}
  style:--stage-edge={p.backgroundEdge}
  style:--stage-scanline={p.scanline}
  style:--stage-label={p.label}
  style:--hud-fill={p.panel.fill}
  style:--hud-border={p.panel.border}
  style:--hud-bracket={p.panel.bracket}
  style:--hud-rule={p.panel.rule}
  style:--hud-title={p.panel.title}
  style:--hud-text={p.panel.text}
  style:--hud-muted={p.panel.muted}
>
  <div class="layer0" class:behind={!ambient} aria-hidden={width === 0 || !ambient}>
    {#if width > 0}
      <div class="center">
        <VoiceOrb mode={orbState.mode} {size} />
        <span class="wordmark">KEITH</span>
      </div>
    {/if}
  </div>

  {#if ambient && width > 0}
    <div class="hud" transition:fade={{ duration: reduced ? 0 : 160 }}>
      <div class="column left">
        <BrainPanel mode={orbState.mode} />
      </div>
      <div class="column right"></div>
    </div>
    {#if workspace.held !== undefined}
      <!-- Keith asked to show something while the person was busy: the way in opens it -->
      <button type="button" class="enter held" onclick={() => workspace.openHeld()}>
        KEITH HAS SOMETHING TO SHOW
      </button>
    {:else}
      <button type="button" class="enter" onclick={() => workspace.setMode('workspace')}>
        WORKSPACE{#if windows > 0}<span class="count">{windows}</span>{/if}
      </button>
    {/if}
  {/if}

  {#if !ambient}
    <!-- the orb stays behind, dimmed and blurred; a click on the backdrop goes back to it -->
    <button
      type="button"
      class="backdrop"
      aria-label="Back to the orb"
      tabindex="-1"
      onclick={() => workspace.setMode('ambient')}
      transition:backdrop={{ reduced }}
    ></button>
    <div class="work" class:phone transition:float={{ reduced }}>
      <div class="surface">
        {#if workspace.mode === 'overview'}<Overview />{:else if phone}<PhoneDesktops />{:else}<Desktop />{/if}
      </div>
      <div class="dockline"><Dock orb={dockOrb} /></div>
    </div>
  {/if}
</main>

<style>
  .stage {
    position: fixed;
    inset: 0;
    overflow: hidden;
    background-color: var(--stage-bg);
    background-image:
      repeating-linear-gradient(0deg, var(--stage-scanline) 0 1px, transparent 1px 3px),
      radial-gradient(ellipse at 50% 42%, var(--stage-centre), var(--stage-edge) 70%);
    font-family: var(--font-mono);
  }
  /* layer 0: the orb fills the screen behind everything */
  .layer0 {
    position: absolute;
    inset: 0;
    z-index: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
  }
  /* the orb behind the floating workspace: a little smaller and quieter, so the windows read first */
  .layer0 > .center { transition: transform 0.28s ease-out, opacity 0.28s ease-out; }
  .layer0.behind > .center { transform: scale(0.86); opacity: 0.55; }
  @media (prefers-reduced-motion: reduce) {
    .layer0 > .center { transition: none; }
  }
  .center {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .wordmark {
    /* the orb's empty corners overlap the wordmark, as in the design */
    margin-top: -1rem;
    padding-left: 0.5em;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.5em;
    color: var(--stage-label);
  }
  /* the floating layer: one scrolling column on a narrow screen, starting low so the orb shows first */
  .hud {
    position: absolute;
    inset: 0;
    z-index: 1;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    padding: 72dvh 16px 24px;
    box-sizing: border-box;
  }
  .column {
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: 100%;
    max-width: 320px;
  }
  .column:empty { display: none; }
  /* wide: a column at each side, top aligned, over the orb */
  .sides .hud {
    flex-direction: row;
    justify-content: space-between;
    align-items: flex-start;
    padding: 32px;
    overflow: hidden;
  }
  .sides .column { width: 300px; max-height: 100%; overflow-y: auto; }
  .sides .column:empty { display: flex; }
  /* ambient: the way into the workspace, under the orb */
  .enter {
    position: absolute;
    z-index: 2;
    left: 50%;
    bottom: 20px;
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 14px;
    background: var(--hud-fill);
    border: 1px solid var(--hud-border);
    color: var(--hud-muted);
    font: inherit;
    font-size: 10px;
    letter-spacing: 0.24em;
    cursor: pointer;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }
  .enter:hover, .enter:focus-visible { color: var(--hud-title); border-color: var(--hud-bracket); }
  .enter.held { color: var(--hud-title); border-color: var(--hud-bracket); }
  .count { font-size: 9px; letter-spacing: 0; }
  /* workspace and overview: a dimmed, blurred backdrop over the orb, and the desktop floating above it, the dock at the bottom */
  .backdrop {
    position: absolute;
    inset: 0;
    z-index: 3;
    margin: 0;
    padding: 0;
    border: 0;
    background: rgb(4 6 8 / 0.55);
    backdrop-filter: blur(10px) saturate(0.8);
    -webkit-backdrop-filter: blur(10px) saturate(0.8);
    cursor: default;
  }
  .work {
    position: absolute;
    inset: 20px 20px 12px;
    z-index: 4;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px 12px 0;
    box-sizing: border-box;
    border: 1px solid var(--hud-border);
    background: rgb(10 13 16 / 0.72);
    box-shadow: 0 24px 64px rgb(0 0 0 / 0.55);
    transform-origin: 50% 60%;
  }
  .work.phone { inset: 0; border: 0; padding: 16px 16px 12px; }
  .surface { position: relative; flex: 1; min-height: 0; }
  .dockline { display: flex; justify-content: center; min-width: 0; padding-bottom: 12px; }
</style>
