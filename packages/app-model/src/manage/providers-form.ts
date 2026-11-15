import type { FormField, ProviderDescription } from '@keith/contracts'
import type { FieldSpec } from './types.ts'

// The add-connection form drawn from a provider's own `formSpec` (`providers.describe`): one input per setting the provider declares, so
// a client needs no per-provider code. Pure: the web draws `providerFieldSpecs` and sends `providerSettings`.

/** The kinds a plain input can hold; a record, an array or raw JSON is edited with the provider's own tools. */
const SIMPLE: ReadonlySet<FormField['kind']> = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'enum',
])

/** The id of a setting's input in the form (`s:` keeps it apart from the connection's own fields). */
export const settingFieldId = (path: string): string => `s:${path}`

const textOf = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : ''

/** The inputs of a provider's settings, auth first, then the endpoint, then the rest. */
export function providerFieldSpecs(desc: ProviderDescription): FieldSpec[] {
  const order = { auth: 0, endpoint: 1, advanced: 2 } as const
  return desc.fields
    .filter((f) => SIMPLE.has(f.kind))
    .map((f, at) => ({ f, at }))
    .sort((a, b) => order[a.f.group] - order[b.f.group] || a.at - b.at)
    .map(({ f }): FieldSpec => {
      const options =
        f.kind === 'boolean'
          ? ['true', 'false']
          : f.kind === 'enum'
            ? (f.options ?? []).map((o) => String(o.value))
            : undefined
      const initial = textOf(f.default)
      return {
        id: settingFieldId(f.path),
        label: f.label,
        ...(f.secret || f.widget === 'password' ? { secret: true } : {}),
        ...(options === undefined ? {} : { options }),
        ...(initial === '' ? {} : { initial }),
        ...(f.required ? {} : { optional: true }),
        ...(f.placeholder === undefined ? {} : { placeholder: f.placeholder }),
      }
    })
}

function put(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let at = target
  for (const part of parts.slice(0, -1)) {
    const next = at[part]
    if (typeof next === 'object' && next !== null) at = next as Record<string, unknown>
    else {
      const made: Record<string, unknown> = {}
      at[part] = made
      at = made
    }
  }
  at[parts[parts.length - 1] ?? path] = value
}

/**
 * The `settings` patch of the form's values: a blank optional input is left out, a number is parsed (a sentence names the field when it
 * is not one), a choice keeps its type. Throws the sentence the form shows.
 */
export function providerSettings(
  desc: ProviderDescription,
  values: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of desc.fields) {
    if (!SIMPLE.has(f.kind)) continue
    const text = (values[settingFieldId(f.path)] ?? '').trim()
    // a secret is never trimmed away: a key with spaces is the person's own business, but a blank one is no key
    const raw = f.secret ? (values[settingFieldId(f.path)] ?? '') : text
    if (raw.trim() === '') continue
    if (f.kind === 'number' || f.kind === 'integer') {
      const n = Number(text)
      if (!Number.isFinite(n) || (f.kind === 'integer' && !Number.isInteger(n)))
        throw new Error(
          `${f.label} must be ${f.kind === 'integer' ? 'a whole number' : 'a number'}`,
        )
      put(out, f.path, n)
    } else if (f.kind === 'boolean') put(out, f.path, text === 'true')
    else if (f.kind === 'enum') {
      const picked = (f.options ?? []).find((o) => String(o.value) === text)
      put(out, f.path, picked === undefined ? text : picked.value)
    } else put(out, f.path, raw)
  }
  return out
}

/** The first required setting left blank, as a sentence; `undefined` when the form may go. */
export function missingSetting(
  desc: ProviderDescription,
  values: Readonly<Record<string, string>>,
): string | undefined {
  const bad = desc.fields.find(
    (f) => SIMPLE.has(f.kind) && f.required && (values[settingFieldId(f.path)] ?? '').trim() === '',
  )
  return bad === undefined ? undefined : `${bad.label} is required`
}
