import { describe, expect, test } from 'bun:test'
import type { FormField, ProviderDescription } from '@keith/contracts'
import {
  missingSetting,
  providerFieldSpecs,
  providerSettings,
  settingFieldId,
} from './providers-form.ts'

const field = (over: Partial<FormField> & Pick<FormField, 'path' | 'kind'>): FormField => ({
  label: over.path,
  required: false,
  secret: false,
  secretValues: false,
  group: 'advanced',
  ...over,
})

const desc = (fields: FormField[]): ProviderDescription => ({
  id: 'p',
  label: 'P',
  fields,
  canListModels: false,
  canTest: true,
})

const D = desc([
  field({ path: 'baseUrl', kind: 'string', group: 'endpoint', placeholder: 'https://' }),
  field({ path: 'apiKey', kind: 'string', secret: true, required: true, group: 'auth' }),
  field({ path: 'retries', kind: 'integer', default: 2 }),
  field({ path: 'stream', kind: 'boolean', default: true }),
  field({
    path: 'region',
    kind: 'enum',
    options: [
      { value: 'eu', label: 'EU' },
      { value: 'us', label: 'US' },
    ],
  }),
  field({ path: 'headers', kind: 'record' }),
])

describe('providerFieldSpecs', () => {
  test('auth first, then the endpoint; a record is left to the provider tools', () => {
    const specs = providerFieldSpecs(D)
    expect(specs.map((s) => s.id)).toEqual(
      ['apiKey', 'baseUrl', 'retries', 'stream', 'region'].map(settingFieldId),
    )
  })

  test('a secret is hidden and required, a boolean is a choice with its default', () => {
    const specs = providerFieldSpecs(D)
    expect(specs[0]).toMatchObject({ secret: true })
    expect(specs[0]?.optional).toBeUndefined()
    expect(specs[3]).toMatchObject({ options: ['true', 'false'], initial: 'true', optional: true })
    expect(specs[4]?.options).toEqual(['eu', 'us'])
  })
})

describe('providerSettings', () => {
  test('blank optional inputs are left out; numbers and booleans are typed', () => {
    const values = {
      [settingFieldId('apiKey')]: 'sk-test',
      [settingFieldId('baseUrl')]: ' ',
      [settingFieldId('retries')]: '3',
      [settingFieldId('stream')]: 'false',
      [settingFieldId('region')]: 'us',
    }
    expect(providerSettings(D, values)).toEqual({
      apiKey: 'sk-test',
      retries: 3,
      stream: false,
      region: 'us',
    })
  })

  test('a number that is not one names the field', () => {
    expect(() => providerSettings(D, { [settingFieldId('retries')]: '2.5' })).toThrow(
      'retries must be a whole number',
    )
  })

  test('a dotted path nests', () => {
    const d = desc([field({ path: 'a.b', kind: 'string' })])
    expect(providerSettings(d, { [settingFieldId('a.b')]: 'x' })).toEqual({ a: { b: 'x' } })
  })
})

describe('missingSetting', () => {
  test('the first required input left blank', () => {
    expect(missingSetting(D, {})).toBe('apiKey is required')
    expect(missingSetting(D, { [settingFieldId('apiKey')]: 'k' })).toBeUndefined()
  })
})
