// Pieces of the setup wizard screen: step dots, the model question and the summary.
import type { PrimaryModelRole } from '@keith/contracts'
import { parseUsdLimit } from '@keith/contracts'
import { Notice, PulseGlyph, Txt } from '@keith/ui'
import { Box, useInput } from 'ink'
import { useEffect } from 'react'
import type { OfflineAdmin } from '../modules/admin/index.ts'
import type { Config } from '../platform/config.ts'
import { money } from './prompt-helpers.ts'
import { ENV_KEYS, modelChecker, modelSuggestion, ROLE_LABEL } from './setup-steps.ts'
import type { ProviderInfo } from './setup-wizard-connect.tsx'
import { Field } from './setup-wizard-fields.tsx'
import type { Draft, Loaded } from './setup-wizard-model.ts'

export function Dots({ total, at }: { total: number; at: number }) {
  return (
    <Box>
      {Array.from({ length: total }, (_, i) => (
        <Txt key={i} tone={i === at ? 'accent' : i < at ? 'text' : 'muted'}>
          {i <= at ? '● ' : '○ '}
        </Txt>
      ))}
    </Box>
  )
}

export function providerInfo(
  loaded: Loaded,
  pid: string,
  config: Config,
): ProviderInfo | undefined {
  const description = loaded.described.find((d) => d.id === pid)
  if (description === undefined) return undefined
  const existing = loaded.connections.find((c) => c.id === pid)
  const envVar = ENV_KEYS[pid]
  const envKey = envVar === undefined ? undefined : config.providerEnv[envVar]
  const reusable: ProviderInfo['reusable'] =
    envVar !== undefined &&
    (existing?.source === 'env' || (envKey !== undefined && existing === undefined))
      ? { kind: 'env', envVar }
      : existing !== undefined
        ? { kind: 'saved' }
        : undefined
  return {
    pid,
    label: description.label,
    exists: existing !== undefined,
    hasKeyField: description.hasKeyField,
    reusable,
  }
}

export function ModelStep({
  admin,
  role,
  connection,
  providerId,
  known,
  value,
  width,
  onChange,
  onSubmit,
}: {
  admin: OfflineAdmin
  role: PrimaryModelRole
  connection: string
  providerId: string | undefined
  known: string[]
  value: string
  width: number
  onChange(v: string): void
  onSubmit(v: string): void
}) {
  // offer the saved or default model once, unless the owner already typed one
  useEffect(() => {
    if (value !== '') return
    void modelSuggestion(admin.providers, { connection, providerId, role }).then(
      (s) => s !== undefined && onChange(s),
    )
  }, [])
  return (
    <Field
      label={`${ROLE_LABEL[role]} model`}
      help={
        role === 'front'
          ? 'The agent you talk to.'
          : 'The workers it delegates to (can be the same).'
      }
      value={value}
      width={width}
      validate={modelChecker(connection, known)}
      onChange={onChange}
      onSubmit={(v) => onSubmit(v.trim())}
    />
  )
}

export function Summary({
  draft,
  connection,
  hasKey,
  saving,
  error,
  onSave,
}: {
  draft: Draft
  connection: string | undefined
  hasKey: boolean
  saving: boolean
  error: string | undefined
  onSave(): void
}) {
  useInput((_input, key) => {
    if (key.return && !saving) onSave()
  })
  const budget = parseUsdLimit(draft.budget)
  const rows: Array<[string, string]> = [
    ['name', draft.name],
    [
      'provider',
      draft.provider === 'skip'
        ? (connection ?? 'none yet (keith-core provider add)')
        : `${draft.provider}${hasKey ? ' (new key)' : ''}${draft.untested ? ', untested' : ''}`,
    ],
    ...(connection === undefined
      ? []
      : ([
          ['front', draft.front],
          ['cortex', draft.cortex],
        ] as Array<[string, string]>)),
    ['budget', typeof budget === 'number' ? `${money(budget)} USD / month` : 'no limit'],
    [
      'access',
      draft.mode === 'local'
        ? 'only this computer'
        : `remote${draft.publicUrl === '' ? '' : `, ${draft.publicUrl}`}`,
    ],
    ['owner PIN', draft.hasPin ? 'new' : 'kept (already set)'],
  ]
  return (
    <Box flexDirection="column">
      <Txt bold>Save these settings?</Txt>
      <Box height={1} />
      {rows.map(([k, v]) => (
        <Box key={k}>
          <Box width={12}>
            <Txt tone="muted">{k}</Txt>
          </Box>
          <Txt>{v}</Txt>
        </Box>
      ))}
      <Box height={1} />
      {saving ? (
        <Box>
          <PulseGlyph tone="accent" />
          <Txt> Saving</Txt>
        </Box>
      ) : (
        <Txt tone="muted">Nothing is written until you press enter.</Txt>
      )}
      {error !== undefined && (
        <Box marginTop={1}>
          <Notice level="error" rows={[error]} />
        </Box>
      )}
    </Box>
  )
}
