<script lang="ts">
import type { SignInProblem } from '@keith/client/browser'
import { throttleText } from './login-text.ts'

let { problem, now }: { problem: SignInProblem; now: number } = $props()
</script>

<div class="problem" role="alert">
  <p><span aria-hidden="true">✕</span> {problem.message}</p>
  {#if problem.retryAt !== undefined}
    <p class="wait"><span aria-hidden="true">◐</span> {throttleText(problem.retryAt, now)}</p>
  {/if}
</div>

<style>
  .problem { margin-top: 1rem; font-size: 0.9rem; }
  p { margin: 0 0 0.25rem; color: var(--k-danger); }
  .wait { color: var(--k-warning); font-variant-numeric: tabular-nums; }
  span { font-family: var(--font-mono); }
</style>
