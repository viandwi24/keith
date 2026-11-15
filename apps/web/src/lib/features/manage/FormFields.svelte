<script lang="ts">
import type { FieldSpec } from '@keith/app-model/manage'

let {
  fields,
  values,
  onchange,
  disabled = false,
  showErrors = false,
  idPrefix = 'f',
}: {
  fields: readonly FieldSpec[]
  values: Readonly<Record<string, string>>
  onchange: (id: string, value: string) => void
  disabled?: boolean
  /** Every required field shows its problem (the form was submitted once); before that only a field the person left does. */
  showErrors?: boolean
  idPrefix?: string
} = $props()

let touched = $state<Record<string, boolean>>({})

const required = (f: FieldSpec): boolean => f.optional !== true
const problem = (f: FieldSpec): string | undefined =>
  required(f) && (values[f.id] ?? '').trim() === '' && (showErrors || touched[f.id] === true)
    ? `${f.label} is required`
    : undefined
const touch = (id: string): void => {
  touched[id] = true
}
</script>

{#each fields as f, at (f.id)}
  {@const error = problem(f)}
  {@const name = `${idPrefix}-${f.id}`}
  <div class="k-field">
    <label for={name}>{f.label}{#if required(f)}<span class="req" aria-hidden="true"> *</span>{/if}</label>
    {#if f.options !== undefined}
      <select
        id={name}
        class="k-input"
        {disabled}
        value={values[f.id] ?? ''}
        aria-invalid={error !== undefined}
        onchange={(e) => onchange(f.id, e.currentTarget.value)}
        onblur={() => touch(f.id)}
      >
        {#each f.options as option (option)}
          <option value={option}>{option === '' ? '(none)' : option}</option>
        {/each}
      </select>
    {:else if f.multiline === true}
      <textarea
        id={name}
        class="k-input"
        rows="3"
        {disabled}
        placeholder={f.placeholder}
        value={values[f.id] ?? ''}
        aria-invalid={error !== undefined}
        aria-required={required(f)}
        oninput={(e) => onchange(f.id, e.currentTarget.value)}
        onblur={() => touch(f.id)}
      ></textarea>
    {:else}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        id={name}
        class="k-input"
        type={f.secret === true ? 'password' : 'text'}
        autocomplete={f.secret === true ? 'new-password' : 'off'}
        autocapitalize="off"
        spellcheck="false"
        autofocus={at === 0}
        {disabled}
        placeholder={f.placeholder}
        value={values[f.id] ?? ''}
        aria-invalid={error !== undefined}
        aria-required={required(f)}
        oninput={(e) => onchange(f.id, e.currentTarget.value)}
        onblur={() => touch(f.id)}
      />
    {/if}
    {#if error !== undefined}<span class="k-error-text" role="alert">{error}</span>{/if}
  </div>
{/each}

<style>
  .req { color: var(--k-danger); }
  select.k-input { appearance: auto; }
  textarea.k-input { resize: vertical; font-family: inherit; }
</style>
