// `keith-core succession` (docs/specs/core-cli.md, docs/specs/succession.md "CLI and TUI"): the owner's view of the
// owner-absence settings over the owner socket. `status` reads the owner view; `heir set|clear`, `window`, `pause` and
// `resume` call the `admin.succession.*` procedures. The core decides every rule (the owner, the step-up, the ranges);
// this file only reads the arguments, asks first where a person is removed, and prints what the core answered.
import {
  CliError,
  type Command,
  confirm,
  defineCommand,
  isInteractive,
  stripControl,
  UsageError,
} from '@keith/cli'
import type { SuccessionOwnerView, SuccessionView } from '@keith/contracts'
import { type CliDeps, connectLocal } from './context.ts'

const DAY_MS = 86_400_000
/** The grace period (ADR-0022 §3), used only to name the day a grace ends when the core has not stored it. */
const GRACE_MS = 7 * DAY_MS

const isoOf = (ms: number): string => new Date(ms).toISOString()

/** `never`, `today`, `1 day ago`, `N days ago`: the age of the owner's last sign, in whole days. */
export function signAgeLine(lastSignAt: number | null, now: number): string {
  if (lastSignAt === null) return 'never'
  const days = Math.max(0, Math.floor((now - lastSignAt) / DAY_MS))
  if (days === 0) return 'today'
  return days === 1 ? '1 day ago' : `${days} days ago`
}

/** `off` without an heir; otherwise `armed`, `grace until`, `claimable since` or `claimed` with the heir (the doctor's words). */
export function summaryLine(view: SuccessionOwnerView, now: number): string {
  if (view.heir === null) return 'off'
  const heir = stripControl(view.heir.name)
  if (view.state === 'claimed') return 'claimed'
  if (view.state === 'grace') return `grace until ${isoOf((view.graceStartedAt ?? now) + GRACE_MS)}`
  if (view.state === 'claimable')
    return `claimable since ${isoOf(view.claimableAt ?? view.graceStartedAt ?? now)}`
  const paused =
    view.pausedUntil !== null && view.pausedUntil > now
      ? `, paused until ${isoOf(view.pausedUntil)}`
      : ''
  return `armed (heir: ${heir}, window ${view.windowDays} days)${paused}`
}

/** The owner view, one line per fact. The owner sees the heir by name and the age of the last sign, never the signals. */
function writeOwnerView(
  out: { write(text: string): unknown },
  view: SuccessionOwnerView,
  now: number,
) {
  out.write(`succession: ${summaryLine(view, now)}\n`)
  out.write(`state: ${view.state}\n`)
  out.write(`heir: ${view.heir === null ? 'none' : stripControl(view.heir.name)}\n`)
  out.write(`window: ${view.windowDays} days\n`)
  out.write(`last sign: ${signAgeLine(view.lastSignAt, now)}\n`)
  out.write(
    `paused: ${view.pausedUntil !== null && view.pausedUntil > now ? `until ${isoOf(view.pausedUntil)}` : 'no'}\n`,
  )
}

/** A whole number of days; the core checks the range (7 to 90 for the window, 1 to 180 for a pause). */
function wholeDays(raw: string, usage: string): number {
  if (!/^\d+$/.test(raw)) throw new UsageError(usage)
  return Number(raw)
}

function statusCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'status',
    summary: "The succession: heir, window, state, the owner's last sign and any pause",
    usage: 'status',
    run: async (ctx) => {
      const { client } = await connectLocal(deps)
      const view: SuccessionView = await client.rpc.admin.succession.get()
      const now = Date.now()
      if (view.role === 'owner') {
        writeOwnerView(ctx.io.stdout, view, now)
        return 0
      }
      ctx.io.stdout.write(`state: ${view.state}\n`)
      ctx.io.stdout.write(
        `claim opens: ${view.claimableAt === null ? 'not yet' : isoOf(view.claimableAt)}\n`,
      )
      return 0
    },
  })
}

function heirCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'heir',
    summary: 'Name the heir (set <username>) or clear it (clear); owner, asks first',
    usage: 'heir set <username> [--yes] | heir clear [--yes]',
    positionals: true,
    flags: { yes: { type: 'boolean', description: 'Do not ask first (for scripts)' } },
    run: async (ctx) => {
      const [action, username, ...rest] = ctx.positionals
      const valid =
        (action === 'set' && username !== undefined && username !== '' && rest.length === 0) ||
        (action === 'clear' && username === undefined)
      if (!valid)
        throw new UsageError('usage: succession heir set <username> | succession heir clear')
      const name = username?.toLowerCase()
      if (!ctx.bool('yes')) {
        const question =
          action === 'set'
            ? `make ${stripControl(name ?? '')} the heir? If you go silent for the window, they can claim Keith after a 7-day grace.`
            : 'clear the heir? If you are gone, nobody can take over Keith, and a run in progress ends.'
        if (!isInteractive(ctx.io))
          throw new UsageError(`heir ${action} asks first: run it in a terminal or pass --yes`)
        if (!(await confirm(question, { default: false, io: ctx.io })))
          throw new CliError('nothing was changed')
      }
      const { client } = await connectLocal(deps)
      const view =
        action === 'set'
          ? await client.rpc.admin.succession.setHeir({ person: name ?? '' })
          : await client.rpc.admin.succession.clearHeir()
      writeOwnerView(ctx.io.stdout, view, Date.now())
      return 0
    },
  })
}

function windowCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'window',
    summary: 'The days of silence before the grace starts (7 to 90, default 14); owner',
    usage: 'window <days>',
    positionals: true,
    run: async (ctx) => {
      const [raw, ...rest] = ctx.positionals
      if (raw === undefined || rest.length > 0)
        throw new UsageError('usage: succession window <days>')
      const days = wholeDays(raw, 'usage: succession window <days> (a whole number of days)')
      const { client } = await connectLocal(deps)
      const view = await client.rpc.admin.succession.setWindow({ days })
      writeOwnerView(ctx.io.stdout, view, Date.now())
      return 0
    },
  })
}

function pauseCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'pause',
    summary: 'Pause the succession for days, or until a time; owner (a trip counts as a sign)',
    usage: 'pause <days | time>',
    positionals: true,
    run: async (ctx) => {
      const [raw, ...rest] = ctx.positionals
      if (raw === undefined || rest.length > 0)
        throw new UsageError('usage: succession pause <days | time>')
      const now = Date.now()
      // a whole number is a count of days from now; anything else is a time (ISO 8601, UTC without a zone, or epoch ms)
      let until: number
      if (/^\d+$/.test(raw)) {
        until = now + wholeDays(raw, '') * DAY_MS
      } else {
        until = Date.parse(raw)
        if (!Number.isFinite(until))
          throw new UsageError(
            'pause takes a number of days, or a time such as 2026-11-20T09:00:00Z',
          )
      }
      const { client } = await connectLocal(deps)
      const view = await client.rpc.admin.succession.pause({ until })
      writeOwnerView(ctx.io.stdout, view, Date.now())
      return 0
    },
  })
}

function resumeCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'resume',
    summary: 'End a pause early; owner',
    usage: 'resume',
    run: async (ctx) => {
      const { client } = await connectLocal(deps)
      const view = await client.rpc.admin.succession.resume()
      writeOwnerView(ctx.io.stdout, view, Date.now())
      return 0
    },
  })
}

export function successionCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'succession',
    summary: 'The owner-absence succession: status, heir, window, pause and resume (owner)',
    subcommands: [
      statusCommand(deps),
      heirCommand(deps),
      windowCommand(deps),
      pauseCommand(deps),
      resumeCommand(deps),
    ],
  })
}
