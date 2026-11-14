import type { SignIn, SignInMethodItem, SignInProblem, SignInState } from '@keith/client'
import type { StepField } from '@keith/contracts'
import { Field, G, Notice, Txt, useFooter } from '@keith/ui'
import { Box, useInput } from 'ink'
import { useState } from 'react'
import { LAN_WARNING, REMEMBER_LABEL, throttleText, versionLine } from './login-text.ts'

type Of<S extends SignInState['step']> = Extract<SignInState, { step: S }>

interface FormProps {
  signIn: SignIn
  /** Content width (columns minus the gutter). */
  width: number
  /** The clock, ticking while a countdown is on screen. */
  now: number
  /** Drawn inside Home's panel: `esc` on the identifier box does nothing there (nothing is behind it). */
  embedded?: boolean
  /** Offer "remember this device" (`ctrl+r`) on a method that can be remembered; the socket never does. */
  offerRemember?: boolean
}

/** The problem of a step as rows: the line, and a live countdown while a throttled attempt waits. */
function Problem({ problem, now }: { problem: SignInProblem; now: number }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Notice level="error" rows={[problem.message]} />
      {problem.retryAt !== undefined && (
        <Txt tone="warning">{`${G.working} ${throttleText(problem.retryAt, now)}`}</Txt>
      )}
    </Box>
  )
}

/** One box: a user id, username, email or phone. Pre-filled with the one remembered for this core. */
export function IdentifyStep({
  signIn,
  width,
  now,
  state,
  embedded = false,
}: FormProps & { state: Of<'identify'> }) {
  const [identifier, setIdentifier] = useState(state.identifier)
  useInput((_i, key) => {
    if (key.escape && !embedded) signIn.back()
  })
  useFooter([
    { key: 'enter', action: 'next' },
    ...(embedded ? [] : [{ key: 'esc', action: 'back' }]),
  ])
  return (
    <Box flexDirection="column">
      {!embedded && (
        <Txt tone="muted" wrap="wrap">
          {`${G.done} ${state.core}  ${G.sep}  ${versionLine(state.info.version)}`}
        </Txt>
      )}
      <Box marginTop={embedded ? 0 : 1}>
        <Field
          label="who"
          value={identifier}
          focused
          width={width}
          labelWidth={6}
          placeholder="id, username, email or phone"
          onChange={setIdentifier}
          onSubmit={(text) => void signIn.submitIdentifier(text)}
        />
      </Box>
      {state.problem !== undefined && <Problem problem={state.problem} now={now} />}
    </Box>
  )
}

/** The method tabs: the one on screen in the accent between brackets, a refused one muted with `!`. */
function Tabs({ methods, current }: { methods: readonly SignInMethodItem[]; current: string }) {
  return (
    <Box flexWrap="wrap" columnGap={2}>
      {methods.map((m) => {
        const on = m.id === current
        const label = `${m.available ? '' : `${G.warn} `}${m.label}`
        return on ? (
          <Txt key={m.id} bold tone="accent">{`[${label}]`}</Txt>
        ) : (
          <Txt key={m.id} tone="muted">{` ${label} `}</Txt>
        )
      })}
    </Box>
  )
}

const isSecret = (f: StepField): boolean => f.kind === 'secret' || f.mask === true
/** A digits field takes digits only (a pasted `123 456` loses the space). */
const clean = (f: StepField, value: string): string =>
  f.kind === 'digits' ? value.replace(/\D/g, '') : value

/**
 * The fields of one step, drawn from their description: a text field, a masked one, digits, a
 * code. Mounted per (method, step), so a switch of method starts empty and a secret never
 * outlives the step it was typed in. `enter` moves to the next field, and on the last one submits.
 */
function StepFields({
  fields,
  width,
  onSubmit,
}: {
  fields: readonly StepField[]
  width: number
  onSubmit(values: Record<string, string>): void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [at, setAt] = useState(0)
  const labelWidth = Math.min(16, Math.max(6, ...fields.map((f) => Array.from(f.label).length + 1)))
  const submit = (): void => {
    const next = fields.findIndex((f) => (values[f.name] ?? '') === '')
    if (next !== -1) {
      setAt(next)
      return
    }
    const sent = { ...values }
    // the secrets leave the field before the call returns
    setValues({})
    setAt(0)
    onSubmit(sent)
  }
  return (
    <Box flexDirection="column">
      {fields.map((f, i) => (
        <Field
          key={f.name}
          label={f.label}
          value={values[f.name] ?? ''}
          focused={i === at}
          width={width}
          labelWidth={labelWidth}
          secret={isSecret(f)}
          onChange={(v) => setValues((cur) => ({ ...cur, [f.name]: clean(f, v) }))}
          onSubmit={() => (i < fields.length - 1 ? setAt(i + 1) : submit())}
        />
      ))}
    </Box>
  )
}

/** The opt-in to keep this sign-in on the device: one line. */
function RememberRow({ on, tight }: { on: boolean; tight: boolean }) {
  return (
    <Box marginTop={tight ? 0 : 1}>
      <Txt tone={on ? 'accent' : 'muted'}>{`${on ? '[x]' : '[ ]'} ${REMEMBER_LABEL}`}</Txt>
    </Box>
  )
}

/**
 * The method the core chose for this client and the others as tabs (`tab` switches). The step is
 * drawn from the core's description (`current.fields`), so a new method needs no code here. A refused
 * method shows the core's `reason`. On the LAN (plain HTTP) a visible warning stands next to a secret.
 */
export function FlowStep({
  signIn,
  width,
  now,
  state,
  embedded = false,
  offerRemember = false,
}: FormProps & { state: Of<'flow'> }) {
  const methods = state.methods
  const at = Math.max(
    0,
    methods.findIndex((m) => m.id === state.method),
  )
  const method = methods[at]
  const poll = method?.interaction === 'poll'
  const canRemember = offerRemember && signIn.canRememberDevice()
  const [remember, setRemember] = useState(() => signIn.rememberDevice())
  useInput((input, key) => {
    if (key.escape) return signIn.back()
    if (key.ctrl && input === 'r' && canRemember) {
      signIn.setRememberDevice(!remember)
      setRemember(!remember)
      return
    }
    if (key.tab && methods.length > 1) {
      const step = key.shift ? methods.length - 1 : 1
      const next = methods[(at + step) % methods.length]
      if (next !== undefined) signIn.chooseMethod(next.id)
      return
    }
    if (key.return && poll && method?.available === true) void signIn.submitStep({})
  })
  useFooter([
    ...(method?.available === true
      ? [{ key: 'enter', action: poll ? 'ask for a code' : 'sign in' }]
      : []),
    ...(methods.length > 1 ? [{ key: 'tab', action: 'method' }] : []),
    ...(canRemember ? [{ key: 'ctrl+r', action: 'remember' }] : []),
    { key: 'esc', action: 'back' },
  ])
  const secret = state.current.fields.some(isSecret)
  return (
    <Box flexDirection="column">
      {!embedded && (
        <Txt tone="muted" wrap="wrap">
          {`${G.done} ${state.core}  ${G.sep}  ${state.identifier}`}
        </Txt>
      )}
      <Box marginTop={embedded ? 0 : 1}>
        <Tabs methods={methods} current={state.method} />
      </Box>
      <Box marginTop={embedded ? 0 : 1} flexDirection="column">
        {method !== undefined && !method.available ? (
          <Txt
            tone="muted"
            wrap="wrap"
          >{`not available here${method.reason === undefined ? '' : `: ${method.reason}`}`}</Txt>
        ) : (
          <>
            {state.current.help !== undefined && (
              <Txt tone="muted" wrap="wrap">
                {state.current.help}
              </Txt>
            )}
            <StepFields
              key={`${state.method}/${state.current.id}`}
              fields={state.current.fields}
              width={width}
              onSubmit={(values) => void signIn.submitStep(values)}
            />
          </>
        )}
      </Box>
      {canRemember && <RememberRow on={remember} tight={embedded} />}
      {state.context === 'lan' && secret && method?.available === true && (
        <Box marginTop={1}>
          <Notice level="warning" rows={[LAN_WARNING]} />
        </Box>
      )}
      {state.problem !== undefined && <Problem problem={state.problem} now={now} />}
    </Box>
  )
}
