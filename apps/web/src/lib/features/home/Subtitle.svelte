<script lang="ts">
import { advanceShown, retargetShown } from '@keith/ui/orb'
import { motion } from '../shell/index.ts'
import { columnsFor, subtitleLines } from './subtitle.ts'

let { text }: { text: string } = $props()

const FONT_PX = 18
const TICK_MS = 40

let width = $state(640)
let shown = $state(0)
let prev = ''

const chars = $derived([...text])
// a text that continues the last one keeps its progress; any other restarts the typing
$effect.pre(() => {
  shown = retargetShown(prev, shown, text)
  prev = text
  if (motion.still) shown = chars.length
})
// type the words out while behind (and the tab is visible)
$effect(() => {
  if (motion.still || shown >= chars.length) return undefined
  let at = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    shown = advanceShown(shown, chars.length, (now - at) / 1000)
    at = now
    if (shown >= chars.length) clearInterval(timer)
  }, TICK_MS)
  return () => clearInterval(timer)
})

const lines = $derived(subtitleLines(chars.slice(0, shown).join(''), columnsFor(width, FONT_PX)))
</script>

<!-- two rows are always reserved, so nothing jumps while the words arrive -->
<p class="subtitle" bind:clientWidth={width} style:--font="{FONT_PX}px" aria-live="polite">
  {#each [0, 1] as i (i)}<span class="row">{lines[i] ?? ''}</span>{/each}
</p>

<style>
  .subtitle {
    display: flex;
    flex-direction: column;
    margin: 0;
    width: 100%;
    max-width: 44rem;
    min-height: calc(var(--font) * 1.5 * 2);
    font-size: var(--font);
    line-height: 1.5;
    text-align: center;
    color: var(--k-text);
  }
  .row { display: block; min-height: 1.5em; white-space: pre; overflow: hidden; }
</style>
