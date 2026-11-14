// The full-screen setup wizard (`keith-core setup` on a terminal). It collects answers step by
// step and writes them all through `applySetup` when the owner confirms the summary, so leaving
// with Esc saves nothing. Step logic lives in setup-steps.ts, shared with the line prompts.
import { type Hint, KeyHints, Notice, PulseGlyph, Screen, Txt } from '@keith/ui'
import { Box, useInput, useWindowSize } from 'ink'
import { useEffect, useRef, useState } from 'react'
import type { OfflineAdmin } from '../modules/admin/index.ts'
import { checkPin, type Hasher } from '../modules/auth/index.ts'
import type { Config } from '../platform/config.ts'
import type { WizardOutcome } from './console-types.ts'
import { applySetup, type SetupAnswers } from './setup-apply.ts'
import {
  budgetProblem,
  ENV_KEYS,
  knownModels,
  nameProblem,
  SETUP_PROVIDERS,
  urlProblem,
} from './setup-steps.ts'
import { type ConnectResult, ConnectStep } from './setup-wizard-connect.tsx'
import { Choice, Field } from './setup-wizard-fields.tsx'
import { type Draft, type Loaded, load, type StepId, TITLE } from './setup-wizard-model.ts'
import { Dots, ModelStep, providerInfo, Summary } from './setup-wizard-parts.tsx'

export interface SetupWizardProps {
  admin: OfflineAdmin
  config: Config
  hasher?: Hasher | undefined
  onDone(outcome: WizardOutcome): void
}

export function SetupWizard({ admin, config, hasher, onDone }: SetupWizardProps) {
  const { columns } = useWindowSize()
  const width = Math.min(columns, 100)
  const [loaded, setLoaded] = useState<Loaded | undefined>()
  useEffect(() => {
    void load(admin, config).then(setLoaded)
  }, [admin, config])
  if (loaded === undefined) {
    return (
      <Screen title="Keith setup" width={width}>
        <Box>
          <PulseGlyph tone="accent" />
          <Txt> Reading the current settings</Txt>
        </Box>
      </Screen>
    )
  }
  return (
    <Steps
      admin={admin}
      config={config}
      hasher={hasher}
      loaded={loaded}
      width={width}
      onDone={onDone}
    />
  )
}

function Steps({
  admin,
  config,
  hasher,
  loaded,
  width,
  onDone,
}: SetupWizardProps & { loaded: Loaded; width: number }) {
  const [draft, setDraft] = useState(loaded.draft)
  const [step, setStep] = useState<StepId>('name')
  const [known, setKnown] = useState<string[]>([])
  const [error, setError] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  const secrets = useRef({ key: '', pin: '' })
  const [pinDraft, setPinDraft] = useState('')

  const savedConnection = loaded.connections.find((c) => c.enabled)
  const info = providerInfo(loaded, draft.provider, config)
  const connectionOf = (d: Draft): string | undefined =>
    d.provider === 'skip'
      ? savedConnection?.id
      : (loaded.connections.find((c) => c.id === d.provider)?.id ?? d.provider)
  const connection = connectionOf(draft)
  const providerId = draft.provider === 'skip' ? savedConnection?.providerId : draft.provider

  const order = (d: Draft): StepId[] => [
    'name',
    'provider',
    ...(d.provider === 'skip' ? [] : (['connect'] as const)),
    ...(connectionOf(d) === undefined ? [] : (['front', 'cortex'] as const)),
    'budget',
    'access',
    ...(d.mode === 'remote' ? (['url'] as const) : []),
    'pin',
    ...(d.hasPin ? (['pin2'] as const) : []),
    'summary',
  ]
  const steps = order(draft)
  const at = Math.max(0, steps.indexOf(step))

  const advance = (patch: Partial<Draft> = {}): void => {
    const next = { ...draft, ...patch }
    setDraft(next)
    setError(undefined)
    const list = order(next)
    const target = list[list.indexOf(step) + 1]
    if (target !== undefined) setStep(target)
  }
  const back = (): void => {
    if (saving) return
    const target = steps[at - 1]
    if (target === undefined) return
    setError(undefined)
    if (step === 'pin2') {
      secrets.current.pin = ''
      setDraft({ ...draft, hasPin: false })
      setPinDraft('')
      setStep('pin')
      return
    }
    // leaving the connection step backwards drops the key typed there
    if (target === 'connect' || step === 'connect') secrets.current.key = ''
    setStep(target)
  }
  const cancel = (): void => {
    secrets.current = { key: '', pin: '' }
    onDone({ status: 'cancelled' })
  }

  useInput((input, key) => {
    if (key.escape) {
      if (!saving) cancel()
      return
    }
    if ((key.tab && key.shift) || (key.ctrl && input === 'b')) back()
  })

  // models known for a connection that is already saved (the connect step reports new ones)
  useEffect(() => {
    if (
      step !== 'front' ||
      known.length > 0 ||
      draft.provider !== 'skip' ||
      connection === undefined
    )
      return
    void knownModels(admin.providers, connection).then((ids) => ids !== undefined && setKnown(ids))
  }, [step])

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    const answers: SetupAnswers = {
      name: draft.name.trim(),
      ...(draft.provider === 'skip'
        ? {}
        : {
            provider: {
              pid: draft.provider,
              exists: info?.exists ?? false,
              apiKey: draft.reuse || secrets.current.key === '' ? undefined : secrets.current.key,
            },
          }),
      connection,
      models: connection === undefined ? undefined : { front: draft.front, cortex: draft.cortex },
      budget: draft.budget,
      mode: draft.mode,
      publicUrl: draft.mode === 'remote' && draft.publicUrl !== '' ? draft.publicUrl : undefined,
      pin: secrets.current.pin === '' ? undefined : secrets.current.pin,
    }
    try {
      const summary = await applySetup(admin, answers, hasher)
      secrets.current = { key: '', pin: '' }
      onDone({ status: 'saved', summary })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  const hints: Hint[] = [
    { key: 'enter', action: step === 'summary' ? 'save' : 'next' },
    ...(at > 0 ? [{ key: 'shift+tab', action: 'back' }] : []),
    { key: 'esc', action: 'cancel' },
  ]

  return (
    <Screen
      title="Keith setup"
      subtitle={`step ${at + 1} of ${steps.length} · ${TITLE[step]}`}
      width={width}
    >
      <Box flexDirection="column" flexGrow={1}>
        <Dots total={steps.length} at={at} />
        <Box height={1} />
        {step === 'name' && (
          <Field
            label="What should Keith call you?"
            value={draft.name}
            width={width}
            validate={nameProblem}
            onChange={(name) => setDraft({ ...draft, name })}
            onSubmit={(name) => advance({ name: name.trim() })}
          />
        )}
        {step === 'provider' && (
          <Choice
            question="Which AI provider?"
            width={width}
            initial={draft.provider}
            options={[
              ...SETUP_PROVIDERS.map((id) => ({
                value: id as string,
                label: loaded.described.find((d) => d.id === id)?.label ?? id,
                ...(config.providerEnv[ENV_KEYS[id] ?? '']
                  ? { hint: `${ENV_KEYS[id]} found in the environment` }
                  : {}),
              })),
              {
                value: 'skip',
                label: 'Skip for now',
                hint: 'add one later: keith-core provider add',
              },
            ]}
            onPick={(provider) => {
              secrets.current.key = ''
              advance({ provider, reuse: false, untested: false, front: '', cortex: '' })
            }}
          />
        )}
        {step === 'connect' && info !== undefined && (
          <ConnectStep
            key={draft.provider}
            info={info}
            admin={admin}
            secret={{
              get current() {
                return secrets.current.key
              },
              set current(v: string) {
                secrets.current.key = v
              },
            }}
            width={width}
            onDone={(r: ConnectResult) => {
              setKnown(r.known)
              advance({ reuse: r.reuse, untested: r.untested })
            }}
          />
        )}
        {(step === 'front' || step === 'cortex') && connection !== undefined && (
          <ModelStep
            key={step}
            admin={admin}
            role={step}
            connection={connection}
            providerId={providerId}
            known={known}
            value={draft[step]}
            width={width}
            onChange={(v) => setDraft({ ...draft, [step]: v })}
            onSubmit={(v) => advance({ [step]: v })}
          />
        )}
        {step === 'budget' && (
          <Field
            label="Monthly budget in USD"
            help="A number from 0 to 10000, or none for no limit."
            value={draft.budget}
            width={width}
            validate={budgetProblem}
            onChange={(budget) => setDraft({ ...draft, budget })}
            onSubmit={(budget) => advance({ budget: budget.trim() })}
          />
        )}
        {step === 'access' && (
          <Choice
            question="Who will use Keith?"
            width={width}
            initial={draft.mode}
            options={[
              { value: 'local', label: 'Only this computer' },
              {
                value: 'remote',
                label: 'Also my other devices',
                hint: 'Tailscale recommended',
              },
            ]}
            onPick={(mode) => advance({ mode })}
          />
        )}
        {step === 'url' && (
          <Field
            label="URL your devices use to reach core"
            help="Such as https://mac.tailnet.ts.net. Enter for none yet."
            value={draft.publicUrl}
            width={width}
            validate={urlProblem}
            onChange={(publicUrl) => setDraft({ ...draft, publicUrl })}
            onSubmit={(publicUrl) => advance({ publicUrl })}
          />
        )}
        {step === 'pin' && (
          <Field
            label="Owner PIN"
            help={
              loaded.ownerSignIn.length > 0
                ? `6 to 12 digits. The owner already signs in with ${loaded.ownerSignIn.join(' and ')}: Enter keeps it.`
                : '6 to 12 digits. You type it to sign in to Keith on this machine.'
            }
            value={pinDraft}
            mask
            width={width}
            validate={(v) =>
              v === ''
                ? loaded.ownerSignIn.length > 0
                  ? undefined
                  : 'a PIN is needed: nobody could sign in without one'
                : checkPin(v)
            }
            onChange={setPinDraft}
            onSubmit={(v) => {
              secrets.current.pin = v
              setPinDraft('')
              advance({ hasPin: v !== '' })
            }}
          />
        )}
        {step === 'pin2' && (
          <Field
            label="Type the PIN again"
            value={pinDraft}
            mask
            width={width}
            error={error}
            onChange={setPinDraft}
            onSubmit={(v) => {
              setPinDraft('')
              if (v !== secrets.current.pin) {
                secrets.current.pin = ''
                setError('The PINs differ. Enter it again.')
                setDraft({ ...draft, hasPin: false })
                setStep('pin')
                return
              }
              advance()
            }}
          />
        )}
        {step === 'summary' && (
          <Summary
            draft={draft}
            connection={connection}
            hasKey={secrets.current.key !== ''}
            saving={saving}
            error={error}
            onSave={() => void save()}
          />
        )}
        {error !== undefined && step === 'pin' && (
          <Box marginTop={1}>
            <Notice level="error" rows={[error]} />
          </Box>
        )}
      </Box>
      <KeyHints hints={hints} />
    </Screen>
  )
}
