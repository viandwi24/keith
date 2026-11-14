// `keith-core protocols` (docs/specs/core-cli.md, docs/specs/hypothalamus.md "RPC and CLI"): the owner's view of the protocol
// engine over the owner socket. `list`, `show`, `pause`, `resume`, `delete` and `runs` call the `protocols.*` procedures;
// the service decides what the caller may see and change. `settings` is a nested group: it reads `get` or `set` from its
// positionals, as `auth policy` does (`defineCommand` nests one level). Every line the core sends is stripped of controls.
import {
  CliError,
  type Command,
  confirm,
  defineCommand,
  isInteractive,
  printTable,
  stripControl,
  UsageError,
} from '@keith/cli'
import {
  PROTOCOL_MAX_PER_PERSON_MAX,
  PROTOCOL_MAX_RUNS_PER_DAY_MAX,
  PROTOCOL_SETTINGS_DEFAULTS,
  PROTOCOL_TICK_MS_MAX,
  PROTOCOL_TICK_MS_MIN,
  type ProtocolSettings,
  type ProtocolSettingsSet,
  type ProtocolView,
  type Trigger,
} from '@keith/contracts'
import { type CliDeps, connectLocal } from './context.ts'

const HOUR_MS = 3_600_000
/** A pause may run a year at most; the core refuses a pause that ends in the past. */
const PAUSE_HOURS_MAX = 8_760

const isoOf = (ms: number): string => new Date(ms).toISOString()

/** What starts a run of this trigger, in one short line. */
export function triggerLine(trigger: Trigger): string {
  if (trigger.kind === 'time')
    return trigger.cron !== undefined ? `cron ${trigger.cron}` : `at ${isoOf(trigger.at ?? 0)}`
  if (trigger.kind === 'absence')
    return `absent ${stripControl(trigger.person)} for ${trigger.afterMs / HOUR_MS}h`
  if (trigger.kind === 'signal') return `signal ${trigger.type}`
  return `event ${trigger.type}`
}

/** `on`, `off`, or `paused until <time>`: the state a person reads in the list. */
export function stateLine(
  view: Pick<ProtocolView, 'enabled' | 'pausedUntil'>,
  now: number,
): string {
  if (!view.enabled) return 'off'
  if (view.pausedUntil !== null && view.pausedUntil > now)
    return `paused until ${isoOf(view.pausedUntil)}`
  return 'on'
}

/** The engine settings, one line each, with their bounds and defaults. */
export function protocolSettingsLines(values: ProtocolSettings): string[] {
  return [
    `tick: ${values.tickMs} ms (${PROTOCOL_TICK_MS_MIN} to ${PROTOCOL_TICK_MS_MAX}, default ${PROTOCOL_SETTINGS_DEFAULTS.tickMs})`,
    `protocols per person: ${values.maxPerPerson} (1 to ${PROTOCOL_MAX_PER_PERSON_MAX}, default ${PROTOCOL_SETTINGS_DEFAULTS.maxPerPerson})`,
    `runs a day per person: ${values.maxPerPersonRunsPerDay} (1 to ${PROTOCOL_MAX_RUNS_PER_DAY_MAX}, default ${PROTOCOL_SETTINGS_DEFAULTS.maxPerPersonRunsPerDay})`,
  ]
}

/** A flag that must be a whole number; the bounds are checked by the core, which refuses with the range. */
function wholeNumber(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${flag} takes a whole number`)
  return Number(raw)
}

/** The one id a verb takes. */
function idOf(positionals: readonly string[], verb: string): string {
  const [id] = positionals
  if (positionals.length !== 1 || id === undefined || id === '')
    throw new UsageError(`usage: protocols ${verb} <id>`)
  return id
}

/** The pause end from `--until <time>` (ISO 8601 or epoch ms) or `--hours <n>`; `undefined` means no pause (off). */
function pauseUntil(until: string | undefined, hours: string | undefined, now: number) {
  if (until !== undefined && hours !== undefined)
    throw new UsageError('give --until or --hours, not both')
  if (hours !== undefined) {
    const n = wholeNumber(hours, 'hours')
    if (n === undefined || n < 1 || n > PAUSE_HOURS_MAX)
      throw new UsageError(`--hours takes a whole number from 1 to ${PAUSE_HOURS_MAX}`)
    return now + n * HOUR_MS
  }
  if (until === undefined) return undefined
  const ms = /^\d+$/.test(until) ? Number(until) : Date.parse(until)
  if (!Number.isFinite(ms))
    throw new UsageError('--until takes a time such as 2026-11-11T09:00:00Z, or epoch ms')
  return ms
}

function listCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'list',
    summary: 'The protocols you may see: name, owner, trigger and state',
    usage: 'list',
    run: async (ctx) => {
      const { client } = await connectLocal(deps)
      const { protocols } = await client.rpc.protocols.list()
      if (protocols.length === 0) {
        ctx.io.stdout.write('no protocols\n')
        return 0
      }
      const now = Date.now()
      printTable(
        ctx.io,
        protocols.map((p) => [
          stripControl(p.name) + (p.builtIn === null ? '' : ' (built-in)'),
          p.id,
          stripControl(p.owner),
          triggerLine(p.definition.trigger),
          stateLine(p, now),
        ]),
        { header: ['NAME', 'ID', 'OWNER', 'TRIGGER', 'STATE'] },
      )
      return 0
    },
  })
}

function showCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'show',
    summary: 'One protocol: its trigger, its steps and its state',
    usage: 'show <id>',
    positionals: true,
    run: async (ctx) => {
      const id = idOf(ctx.positionals, 'show')
      const { client } = await connectLocal(deps)
      const view = await client.rpc.protocols.get({ id })
      const out = ctx.io.stdout
      out.write(`name: ${stripControl(view.name)}\n`)
      out.write(`id: ${view.id}\n`)
      out.write(`owner: ${stripControl(view.owner)}\n`)
      out.write(`built-in: ${view.builtIn ?? 'no'}\n`)
      out.write(`state: ${stateLine(view, Date.now())}\n`)
      out.write(`version: ${view.version}\n`)
      out.write(`trigger: ${triggerLine(view.definition.trigger)}\n`)
      out.write('steps:\n')
      for (const step of view.definition.steps) {
        const next = step.next === undefined ? '' : `  -> ${step.next}`
        out.write(`  ${step.id}  ${step.kind}${next}\n`)
      }
      return 0
    },
  })
}

function pauseCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'pause',
    summary: 'Pause a protocol until a time, for hours, or switch it off until resume',
    usage: 'pause <id> [--until <time> | --hours <n>]',
    positionals: true,
    flags: {
      until: {
        type: 'string',
        placeholder: 'time',
        description: 'When the pause ends: ISO 8601 (UTC if no zone) or epoch ms',
      },
      hours: {
        type: 'string',
        placeholder: 'n',
        description: `Hours to pause, 1 to ${PAUSE_HOURS_MAX}`,
      },
    },
    run: async (ctx) => {
      const id = idOf(ctx.positionals, 'pause')
      const until = pauseUntil(ctx.string('until'), ctx.string('hours'), Date.now())
      const { client } = await connectLocal(deps)
      if (until === undefined) {
        // no end given: the protocol is switched off, and `resume` switches it on again
        const view = await client.rpc.protocols.setEnabled({ id, enabled: false })
        ctx.io.stdout.write(`${stripControl(view.name)}: ${stateLine(view, Date.now())}\n`)
        return 0
      }
      const view = await client.rpc.protocols.pause({ id, until })
      ctx.io.stdout.write(`${stripControl(view.name)}: ${stateLine(view, Date.now())}\n`)
      return 0
    },
  })
}

function resumeCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'resume',
    summary: 'Turn a protocol back on and end its pause',
    usage: 'resume <id>',
    positionals: true,
    run: async (ctx) => {
      const id = idOf(ctx.positionals, 'resume')
      const { client } = await connectLocal(deps)
      let view = await client.rpc.protocols.get({ id })
      if (!view.enabled) view = await client.rpc.protocols.setEnabled({ id, enabled: true })
      if (view.pausedUntil !== null) view = await client.rpc.protocols.pause({ id, until: null })
      ctx.io.stdout.write(`${stripControl(view.name)}: ${stateLine(view, Date.now())}\n`)
      return 0
    },
  })
}

function deleteCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'delete',
    summary: 'Delete a protocol and its versions; its run history stays',
    usage: 'delete <id> [--yes]',
    positionals: true,
    flags: { yes: { type: 'boolean', description: 'Do not ask first (for scripts)' } },
    run: async (ctx) => {
      const id = idOf(ctx.positionals, 'delete')
      const { client } = await connectLocal(deps)
      const view = await client.rpc.protocols.get({ id })
      const name = stripControl(view.name)
      if (!ctx.bool('yes')) {
        if (!isInteractive(ctx.io))
          throw new UsageError('delete asks first: run it in a terminal or pass --yes')
        if (
          !(await confirm(`delete ${name}? Its versions go; its run history stays.`, {
            default: false,
            io: ctx.io,
          }))
        )
          throw new CliError('nothing was deleted')
      }
      await client.rpc.protocols.delete({ id })
      ctx.io.stdout.write(`${name}: deleted\n`)
      return 0
    },
  })
}

function runsCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'runs',
    summary: 'The newest runs of a protocol: when, status, step, the person it acted for',
    usage: 'runs <id> [--limit n]',
    positionals: true,
    flags: {
      limit: {
        type: 'string',
        placeholder: 'n',
        description: 'Runs to show, 1 to 100 (default 20)',
      },
    },
    run: async (ctx) => {
      const id = idOf(ctx.positionals, 'runs')
      const limit = wholeNumber(ctx.string('limit'), 'limit') ?? 20
      const { client } = await connectLocal(deps)
      const { runs } = await client.rpc.protocols.runs({ protocolId: id, limit })
      if (runs.length === 0) {
        ctx.io.stdout.write('no runs\n')
        return 0
      }
      printTable(
        ctx.io,
        runs.map((r) => [
          isoOf(r.startedAt),
          r.status,
          r.step ?? '-',
          stripControl(r.person),
          stripControl(r.triggerRef),
        ]),
        { header: ['STARTED', 'STATUS', 'STEP', 'PERSON', 'TRIGGER'] },
      )
      return 0
    },
  })
}

function settingsCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'settings',
    summary: 'The engine settings: get, or set (owner; set asks for the step-up)',
    usage:
      'settings get | settings set [--tick-ms <ms>] [--max-per-person <n>] [--max-runs-per-day <n>]',
    positionals: true,
    flags: {
      'tick-ms': {
        type: 'string',
        placeholder: 'ms',
        description: `How often the engine ticks, ${PROTOCOL_TICK_MS_MIN} to ${PROTOCOL_TICK_MS_MAX} (settings set)`,
      },
      'max-per-person': {
        type: 'string',
        placeholder: 'n',
        description: `Protocols one person may own, 1 to ${PROTOCOL_MAX_PER_PERSON_MAX} (settings set)`,
      },
      'max-runs-per-day': {
        type: 'string',
        placeholder: 'n',
        description: `Runs a person may start in a UTC day, 1 to ${PROTOCOL_MAX_RUNS_PER_DAY_MAX} (settings set)`,
      },
    },
    run: async (ctx) => {
      const [action] = ctx.positionals
      if (ctx.positionals.length !== 1 || (action !== 'get' && action !== 'set'))
        throw new UsageError(
          'usage: protocols settings get | protocols settings set [--tick-ms <ms>] [--max-per-person <n>] [--max-runs-per-day <n>]',
        )
      const { client } = await connectLocal(deps)
      if (action === 'get') {
        for (const line of protocolSettingsLines(await client.rpc.protocols.settings.get()))
          ctx.io.stdout.write(`${line}\n`)
        return 0
      }
      const tick = wholeNumber(ctx.string('tick-ms'), 'tick-ms')
      const perPerson = wholeNumber(ctx.string('max-per-person'), 'max-per-person')
      const runs = wholeNumber(ctx.string('max-runs-per-day'), 'max-runs-per-day')
      const change: ProtocolSettingsSet = {
        ...(tick === undefined ? {} : { tickMs: tick }),
        ...(perPerson === undefined ? {} : { maxPerPerson: perPerson }),
        ...(runs === undefined ? {} : { maxPerPersonRunsPerDay: runs }),
      }
      if (Object.keys(change).length === 0)
        throw new UsageError('give at least one of --tick-ms, --max-per-person, --max-runs-per-day')
      const done = await client.rpc.protocols.settings.set(change)
      for (const line of protocolSettingsLines(done)) ctx.io.stdout.write(`${line}\n`)
      return 0
    },
  })
}

export function protocolsCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'protocols',
    summary: 'The protocol engine: list, show, pause, resume, delete, runs and settings (owner)',
    subcommands: [
      listCommand(deps),
      showCommand(deps),
      pauseCommand(deps),
      resumeCommand(deps),
      deleteCommand(deps),
      runsCommand(deps),
      settingsCommand(deps),
    ],
  })
}
