// The `/dream` forms (docs/specs/tui.md, "Commands and keys"; ADR-0031 §5, §8). `/dream` shows the status as an info notice; `now`
// starts a run; `apply` writes the staged plan; `undo` restores the last applied run; `mode off|propose|auto` sets the person's own
// mode. Every call acts on the person's own memory (no step-up). A refusal is a warning toast with its reason in plain words.

import {
  countsTextOf,
  DREAM_REFUSAL_TEXT,
  runOutcomeOf,
  statusRowsOf,
  undoTextOf,
} from '@keith/app-model'
import type { DreamingApi } from '@keith/client'
import { dreamRefusalOf } from '@keith/client'
import type { DreamMode, DreamRefusalReason, DreamRunView } from '@keith/contracts'
import type { ToastLevel } from '@keith/ui'

export type DreamCommand =
  | { kind: 'status' }
  | { kind: 'now' }
  | { kind: 'apply' }
  | { kind: 'undo' }
  | { kind: 'mode'; mode: DreamMode }
  | { kind: 'usage'; text: string }

export const DREAM_USAGE =
  'Usage: /dream · /dream now · /dream apply · /dream undo · /dream mode off|propose|auto'
export const DREAM_MODE_USAGE = 'Usage: /dream mode off · propose · auto'

const MODES: readonly DreamMode[] = ['off', 'propose', 'auto']
const usage = (text: string): DreamCommand => ({ kind: 'usage', text })

/** The words after `/dream`: nothing (status), `now`, `apply`, `undo`, `mode <off|propose|auto>`; anything else is a usage line. */
export function parseDreamCommand(args: string): DreamCommand {
  const words = args
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
  const [sub, value, ...rest] = words
  if (sub === undefined) return { kind: 'status' }
  if (words.length === 1 && sub === 'now') return { kind: 'now' }
  if (words.length === 1 && sub === 'apply') return { kind: 'apply' }
  if (words.length === 1 && sub === 'undo') return { kind: 'undo' }
  if (sub === 'mode') {
    if (value === undefined || rest.length > 0) return usage(DREAM_MODE_USAGE)
    const mode = MODES.find((m) => m === value)
    return mode === undefined ? usage(DREAM_MODE_USAGE) : { kind: 'mode', mode }
  }
  return usage(DREAM_USAGE)
}

/** What a `/dream` command reads and writes: the person's dreaming API, the notice and the toast. */
export interface DreamCommandEnv {
  dreaming: Pick<DreamingApi, 'status' | 'setMode' | 'runNow' | 'apply' | 'undo'>
  say(level: 'info' | 'warning', rows: readonly string[]): void
  toast(text: string, level: ToastLevel): void
  /**
   * The chat is on screen: it shows a `/dream now` outcome as its divider (dream-pending.ts), so no toast repeats it. Absent on
   * the other screens, where the toast is the only word.
   */
  inChat?: {
    finish(run: DreamRunView): void
    refused(reason: DreamRefusalReason): void
  }
}

/** The toast of a refused call (`CONFLICT` with a known reason), or the error's own message for any other error. */
export function dreamFailureText(error: unknown): { text: string; level: ToastLevel } {
  const reason = dreamRefusalOf(error)
  if (reason !== undefined) return { text: DREAM_REFUSAL_TEXT[reason], level: 'warning' }
  return { text: error instanceof Error ? error.message : String(error), level: 'error' }
}

/** Runs a parsed `/dream` command. Each call reads or writes only the caller's own memory through `client.dreaming`. */
export function runDreamCommand(command: DreamCommand, env: DreamCommandEnv): void {
  const failed = (error: unknown): void => {
    const { text, level } = dreamFailureText(error)
    env.toast(text, level)
  }
  switch (command.kind) {
    case 'usage':
      env.say('info', [command.text])
      return
    case 'status':
      void env.dreaming.status().then((status) => env.say('info', statusRowsOf(status)), failed)
      return
    case 'mode':
      void env.dreaming
        .setMode({ mode: command.mode })
        .then((status) => env.toast(`Dreaming mode: ${status.mode}.`, 'success'), failed)
      return
    case 'now':
      void env.dreaming.runNow().then(
        (run) => {
          if (env.inChat !== undefined) return env.inChat.finish(run)
          const { text, level } = runOutcomeOf(run)
          env.toast(text, level)
        },
        (error: unknown) => {
          const reason = dreamRefusalOf(error)
          if (reason !== undefined && env.inChat !== undefined) return env.inChat.refused(reason)
          failed(error)
        },
      )
      return
    case 'undo':
      void env.dreaming.undo().then((done) => {
        const { text, level } = undoTextOf(done)
        env.toast(text, level)
      }, failed)
      return
    case 'apply':
      void applyStaged(env).catch(failed)
      return
  }
}

/** `/dream apply`: the staged plan of the last run (`propose`), written by the person's own call. */
async function applyStaged(env: DreamCommandEnv): Promise<void> {
  const status = await env.dreaming.status()
  // the run that holds the waiting plan: a later run (skipped, refused) does not hide it
  const runId = status.stagedRunId ?? status.lastRun?.id
  if (!status.canApply || runId === undefined) {
    env.toast('No staged plan to apply.', 'info')
    return
  }
  const done = await env.dreaming.apply({ runId })
  // a plan that stopped while writing comes back as a failed run: its words, not "Applied"
  if (done.status !== 'applied') {
    const { text, level } = runOutcomeOf(done)
    env.toast(text, level)
    return
  }
  env.toast(`Applied: ${countsTextOf(done)}.`, 'success')
}
