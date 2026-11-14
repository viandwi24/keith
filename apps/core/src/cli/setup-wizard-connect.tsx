// The provider key step of the wizard: ask for the key (or reuse one), test it, say what failed.
import { Notice, PulseGlyph, Txt } from '@keith/ui'
import { Box } from 'ink'
import { type MutableRefObject, useEffect, useState } from 'react'
import type { OfflineAdmin } from '../modules/admin/index.ts'
import { nonEmpty, probeProvider } from './setup-steps.ts'
import { Choice, Field } from './setup-wizard-fields.tsx'

/** What the wizard knows about the chosen provider. */
export interface ProviderInfo {
  pid: string
  label: string
  /** The connection of this id already exists. */
  exists: boolean
  hasKeyField: boolean
  /** A key that can be reused: the environment's, or the one saved. */
  reusable: { kind: 'env'; envVar: string } | { kind: 'saved' } | undefined
}

export interface ConnectResult {
  /** The key is the saved or environment one. */
  reuse: boolean
  /** Model ids the provider listed (empty when untested or not listed). */
  known: string[]
  /** The owner chose to save a key that failed its test. */
  untested: boolean
}

type Phase = 'choose' | 'key' | 'testing' | 'failed'

export function ConnectStep({
  info,
  admin,
  secret,
  width,
  onDone,
}: {
  info: ProviderInfo
  admin: OfflineAdmin
  /** The key lives here, never in rendered state; the field below is cleared after submit. */
  secret: MutableRefObject<string>
  width: number
  onDone(result: ConnectResult): void
}) {
  const [phase, setPhase] = useState<Phase>(
    !info.hasKeyField ? 'testing' : info.reusable !== undefined ? 'choose' : 'key',
  )
  const [reuse, setReuse] = useState(!info.hasKeyField && info.exists)
  const [draft, setDraft] = useState('')
  const [why, setWhy] = useState('')
  const [run, setRun] = useState(0)

  useEffect(() => {
    if (phase !== 'testing') return undefined
    let live = true
    const apiKey = reuse || secret.current === '' ? undefined : secret.current
    void probeProvider(admin.providers, {
      pid: info.pid,
      settings: apiKey === undefined ? undefined : { apiKey },
      useExisting: reuse || (!info.hasKeyField && info.exists),
      listModels: true,
    }).then((result) => {
      if (!live) return
      if (result.ok) onDone({ reuse, known: result.models ?? [], untested: false })
      else {
        setWhy(result.message ?? 'no answer')
        setPhase('failed')
      }
    })
    return () => {
      live = false
    }
  }, [phase, run])

  if (phase === 'choose') {
    const where =
      info.reusable?.kind === 'env'
        ? `Use ${info.reusable.envVar} from the environment`
        : `Keep the saved ${info.label} key`
    return (
      <Choice
        question={`${info.label} API key`}
        width={width}
        options={[
          { value: 'reuse', label: where },
          { value: 'new', label: 'Enter a new key' },
        ]}
        onPick={(v) => {
          setReuse(v === 'reuse')
          setPhase(v === 'reuse' ? 'testing' : 'key')
        }}
      />
    )
  }
  if (phase === 'key') {
    return (
      <Field
        label={`${info.label} API key`}
        help="Typed hidden; kept in memory until you save, then dropped."
        value={draft}
        mask
        width={width}
        validate={nonEmpty}
        onChange={setDraft}
        onSubmit={(v) => {
          secret.current = v
          setDraft('')
          setRun((n) => n + 1)
          setPhase('testing')
        }}
      />
    )
  }
  if (phase === 'testing') {
    return (
      <Box>
        <PulseGlyph tone="accent" />
        <Txt>{` Testing the ${info.label} connection`}</Txt>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Notice level="error" rows={[`${info.label}: connection failed (${why})`]} />
      <Box height={1} />
      <Choice
        question="What now?"
        width={width}
        options={[
          {
            value: 'again',
            label: info.hasKeyField && !reuse ? 'Try another key' : 'Test again',
          },
          { value: 'anyway', label: 'Save it anyway', hint: 'without a working test' },
        ]}
        onPick={(v) => {
          if (v === 'anyway') return onDone({ reuse, known: [], untested: true })
          if (info.hasKeyField && !reuse) {
            secret.current = ''
            setPhase('key')
          } else {
            setRun((n) => n + 1)
            setPhase('testing')
          }
        }}
      />
    </Box>
  )
}
