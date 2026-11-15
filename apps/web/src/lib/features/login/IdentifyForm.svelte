<script lang="ts">
import type { SignIn, SignInState } from '@keith/client/browser'
import { versionLine } from './login-text.ts'
import Problem from './Problem.svelte'

type Identify = Extract<SignInState, { step: 'identify' }>
let { signIn, step, now }: { signIn: SignIn; step: Identify; now: number } = $props()

// svelte-ignore state_referenced_locally
let identifier = $state(step.identifier)
const throttled = $derived(step.problem?.retryAt !== undefined && step.problem.retryAt > now)

function submit(event: SubmitEvent): void {
  event.preventDefault()
  if (identifier.trim() === '' || throttled) return
  void signIn.submitIdentifier(identifier.trim())
}
</script>

<p class="core"><span aria-hidden="true">✓</span> {versionLine(step.info.version)}</p>
<form onsubmit={submit}>
  <label for="who">Who</label>
  <input
    id="who"
    class="k-input"
    bind:value={identifier}
    placeholder="id, username, email or phone"
    autocomplete="username"
    autocapitalize="none"
    spellcheck="false"
  />
  <button class="k-button primary" type="submit" disabled={identifier.trim() === '' || throttled}>Next</button>
</form>
{#if step.problem !== undefined}<Problem problem={step.problem} {now} />{/if}

<style>
  .core { margin: 0 0 1.25rem; color: var(--k-text-muted); font-size: 0.85rem; }
  .core span { color: var(--k-success); font-family: var(--font-mono); }
  form { display: grid; gap: 0.5rem; }
  label { font-size: 0.85rem; color: var(--k-text-muted); }
  button { margin-top: 0.75rem; }
</style>
