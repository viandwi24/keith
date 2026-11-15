<script lang="ts">
import type { SignIn, SignInState } from '@keith/client/browser'
import { expiresText, spacedCode } from './login-text.ts'

type Device = Extract<SignInState, { step: 'device' }>
let { signIn, step, now }: { signIn: SignIn; step: Device; now: number } = $props()
</script>

{#if step.code === undefined}
  <p class="muted">Asking the core for a code …</p>
{:else}
  <p>On the core machine, approve this device:</p>
  <pre class="cmd">keith-core devices approve {step.code} --label &lt;name&gt;</pre>
  <p class="code" aria-label="Code {step.code}">{spacedCode(step.code)}</p>
  <p class="muted">
    <span aria-hidden="true">{step.polling ? '◐' : '○'}</span>
    {step.polling ? 'waiting for approval' : 'connecting'}{step.expiresAt === undefined
      ? ''
      : ` · ${expiresText(step.expiresAt, now)}`}
  </p>
{/if}
<button class="k-button" type="button" onclick={() => signIn.cancel()}>Cancel</button>

<style>
  p { margin: 0 0 0.75rem; }
  .muted { color: var(--k-text-muted); font-size: 0.9rem; }
  .cmd {
    margin: 0 0 1rem;
    padding: 0.6rem 0.75rem;
    border-radius: var(--radius);
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--k-accent);
    font-family: var(--font-mono);
    font-size: 0.85rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .code { font-family: var(--font-mono); font-size: 1.6rem; font-weight: 700; letter-spacing: 0.1em; }
</style>
