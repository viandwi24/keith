<script lang="ts">
import type { SignIn, SignInState } from '@keith/client/browser'
import { Tabs } from 'bits-ui'
import { LAN_WARNING, REMEMBER_LABEL, throttleText } from './login-text.ts'
import Problem from './Problem.svelte'
import {
  cleanFieldValue,
  fieldAttrs,
  firstEmpty,
  isPlainLan,
  isSecretField,
  showLanWarning,
  tabLabel,
} from './sign-in-view.ts'

type Flow = Extract<SignInState, { step: 'flow' }>
let { signIn, flow, now }: { signIn: SignIn; flow: Flow; now: number } = $props()

let values = $state<Record<string, string>>({})
// svelte-ignore state_referenced_locally
let remember = $state(signIn.rememberDevice())
let busyFields = $state(false)

const method = $derived(flow.methods.find((m) => m.id === flow.method))
const poll = $derived(method?.interaction === 'poll')
const usable = $derived(method?.available === true)
const secret = $derived(flow.current.fields.some(isSecretField))
const canRemember = $derived(signIn.canRememberDevice())
const plain = isPlainLan(globalThis.location)
const retryAt = $derived(flow.problem?.retryAt)
const throttled = $derived(retryAt !== undefined && retryAt > now)

// a switch of method or step starts empty: a secret never outlives the step it was typed in
$effect(() => {
  void flow.method
  void flow.current.id
  values = {}
})

function submit(event: SubmitEvent): void {
  event.preventDefault()
  if (throttled || !usable) return
  if (!poll && firstEmpty(flow.current.fields, values) !== -1) {
    busyFields = true
    return
  }
  const sent = { ...values }
  values = {}
  busyFields = false
  void signIn.submitStep(sent)
}
</script>

<p class="who"><span aria-hidden="true">✓</span> {flow.identifier}</p>

<Tabs.Root value={flow.method} onValueChange={(id) => signIn.chooseMethod(id)}>
  <Tabs.List class="k-tabs" aria-label="Sign-in method">
    {#each flow.methods as m (m.id)}
      <Tabs.Trigger value={m.id} class="k-tab">{tabLabel(m)}</Tabs.Trigger>
    {/each}
  </Tabs.List>
  <Tabs.Content value={flow.method} class="k-tab-panel">
    {#if !usable}
      <p class="muted">Not available here{method?.reason === undefined ? '' : `: ${method.reason}`}</p>
    {:else}
      <form onsubmit={submit}>
        {#if flow.current.help !== undefined}<p class="muted">{flow.current.help}</p>{/if}
        {#each flow.current.fields as field, i (field.name)}
          {@const attrs = fieldAttrs(field)}
          <label for="f-{field.name}">{field.label}</label>
          <input
            id="f-{field.name}"
            class="k-input"
            class:mono={attrs.mono}
            type={attrs.type}
            inputmode={attrs.inputmode}
            autocomplete={attrs.autocomplete as 'off'}
            maxlength={attrs.maxlength}
            autocapitalize="none"
            spellcheck="false"
            value={values[field.name] ?? ''}
            aria-invalid={busyFields && (values[field.name] ?? '') === ''}
            oninput={(e) => (values[field.name] = cleanFieldValue(field, e.currentTarget.value))}
          />
        {/each}
        {#if canRemember}
          <label class="check">
            <input type="checkbox" bind:checked={remember} onchange={() => signIn.setRememberDevice(remember)} />
            {REMEMBER_LABEL}
          </label>
        {/if}
        {#if showLanWarning(flow, plain, secret)}
          <p class="warn" role="note"><span aria-hidden="true">!</span> {LAN_WARNING}</p>
        {/if}
        <button class="k-button primary" type="submit" disabled={throttled}>
          {poll ? 'Ask for a code' : 'Sign in'}
        </button>
        {#if throttled && retryAt !== undefined}
          <p class="muted">{throttleText(retryAt, now)}</p>
        {/if}
      </form>
    {/if}
  </Tabs.Content>
</Tabs.Root>
{#if flow.problem !== undefined}<Problem problem={flow.problem} {now} />{/if}
<button class="k-button link" type="button" onclick={() => signIn.back()}>Use another id</button>

<style>
  .who { margin: 0 0 1rem; color: var(--k-text-muted); font-size: 0.85rem; overflow-wrap: anywhere; }
  .who span { color: var(--k-success); font-family: var(--font-mono); }
  form { display: grid; gap: 0.5rem; margin-top: 1rem; }
  label { font-size: 0.85rem; color: var(--k-text-muted); }
  .check { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.5rem; color: var(--k-text); }
  .muted { margin: 0.75rem 0 0; color: var(--k-text-muted); font-size: 0.9rem; }
  .warn { margin: 0.5rem 0 0; color: var(--k-warning); font-size: 0.85rem; }
  .warn span { font-family: var(--font-mono); font-weight: 700; }
  .mono { font-family: var(--font-mono); letter-spacing: 0.08em; }
  button[type='submit'] { margin-top: 0.75rem; }
</style>
