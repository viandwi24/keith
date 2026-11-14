// `keith-core logs ...`: the model-call log (docs/specs/activity-logs.md, "CLI", ADR-0032 §10). Reads and settings go over the
// owner's local socket through `rpc.logs.*`, so the owner path (another person's rows, every raw read) is audited by the
// same procedures as the TUI: the actor is the local owner. `prune` runs with core stopped, like `db migrate`.
import { existsSync } from 'node:fs'
import {
  CliError,
  type Command,
  type CommandContext,
  defineCommand,
  printTable,
  UsageError,
} from '@keith/cli'
import {
  type LlmCallRecord,
  type LlmSessionKind,
  LlmSessionKindSchema,
  type LogsCallOutput,
  type LogsSessionOutput,
  type LogsSettings,
  LogsSettingsSchema,
  type LogsSettingsSet,
  LogsSettingsSetSchema,
} from '@keith/contracts'
import { activityLogsRepo, auditRepo, openDatabase, settingsRepo } from '@keith/db'
import { createActivityLogSettings } from '../modules/audit/activity-logs/index.ts'
import { createAudit } from '../modules/audit/audit.ts'
import { DAY_MS } from '../platform/retention.ts'
import { type CliDeps, configOf, connectLocal, requireOffline } from './context.ts'

const MICRO_PER_USD = 1_000_000
const HOUR_MS = 3_600_000

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
const usd = (micro: number | null): string =>
  micro === null ? '-' : `${(micro / MICRO_PER_USD).toFixed(4)} USD`
const ms = (value: number | null): string => (value === null ? '-' : `${value} ms`)
const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`
const onePart = (text: string): string => cut(text.replace(/\s+/g, ' ').trim(), 100)

/** `--since`: `12h`, `7d`, or a date or time the Date parser reads. Returns the start in epoch ms. */
export function sinceOf(text: string, now: number): number {
  const rel = /^(\d+)([hd])$/.exec(text)
  if (rel !== null) {
    const n = Number(rel[1])
    return now - n * (rel[2] === 'd' ? DAY_MS : HOUR_MS)
  }
  const at = Date.parse(text)
  if (Number.isNaN(at)) throw new UsageError('--since takes 12h, 7d or a date (2026-11-01)')
  return at
}

function wholeNumber(flag: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new UsageError(`--${flag} takes a whole number, not ${value}`)
  return Number(value)
}

function onOff(flag: string, value: string): boolean {
  if (value === 'on') return true
  if (value === 'off') return false
  throw new UsageError(`--${flag} takes on or off, not ${value}`)
}

function positional(ctx: CommandContext, what: string): string {
  const value = ctx.positionals[0]
  if (value === undefined) throw new UsageError(`missing ${what}`)
  return value
}

function printJson(ctx: CommandContext, value: unknown): void {
  ctx.io.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/** The figures of one call, one `key: value` line each (no message text). */
export function callLines(call: LlmCallRecord): string[] {
  return [
    `call ${call.id}: ${call.kind}${call.trigger === null ? '' : ` (${call.trigger})`} in session ${call.sessionId}`,
    `model: ${call.modelId} via ${call.provider}${call.upstreamProvider === null ? '' : ` (${call.upstreamProvider})`}`,
    `status: ${call.status}${call.finishReason === null ? '' : `, finish ${call.finishReason}`}${call.errorName === null ? '' : `, ${call.errorName}`}`,
    `latency: ${ms(call.durationMs)}, first chunk ${ms(call.firstChunkMs)}`,
    `tokens: ${call.tokensIn} in, ${call.tokensOut} out`,
    `cost: ${usd(call.costMicro)}${call.costSource === null ? '' : ` (${call.costSource})`}`,
    `bodies: ${call.bodyState}`,
  ]
}

/** The session header lines of `logs show`. */
function sessionLines(out: LogsSessionOutput): string[] {
  const s = out.session
  return [
    `session ${s.id}: ${s.kind} (${s.app})`,
    `person: ${s.personId ?? '-'}${s.roomId === null ? '' : `, room ${s.roomId}`}`,
    `model: ${s.primaryModel ?? '-'}${s.primaryProvider === null ? '' : ` via ${s.primaryProvider}`}`,
    `calls: ${s.calls}, cost ${usd(s.costMicro)}, ${when(s.firstAt)} to ${when(s.lastAt)}`,
  ]
}

function printCall(ctx: CommandContext, out: LogsCallOutput): void {
  for (const line of callLines(out.call)) ctx.io.stdout.write(`${line}\n`)
  if (out.messages.length > 0) {
    ctx.io.stdout.write(`messages (${out.messages.length}):\n`)
    printTable(
      ctx.io,
      out.messages.map((m) => [m.role, onePart(m.text)]),
      { header: ['ROLE', 'TEXT'] },
    )
  }
  if (out.toolCalls.length > 0) {
    ctx.io.stdout.write(`tool calls (${out.toolCalls.length}):\n`)
    printTable(
      ctx.io,
      out.toolCalls.map((t) => [t.toolName, t.toolCallId, onePart(t.input)]),
      { header: ['TOOL', 'CALL', 'INPUT'] },
    )
  }
  if (out.outputText !== '') ctx.io.stdout.write(`output: ${onePart(out.outputText)}\n`)
  if (out.truncated) ctx.io.stdout.write('(the body was cut)\n')
}

/** The settings as `key value` rows (the order of the flags). */
function settingRows(s: LogsSettings): string[][] {
  return [
    ['capture-bodies', s.captureBodies ? 'on' : 'off'],
    ['guest-bodies', s.guestBodies ? 'on' : 'off'],
    ['body-days', String(s.bodyRetentionDays)],
    ['meta-days', String(s.metaRetentionDays)],
    ['max-body-bytes', String(s.maxBodyBytes)],
  ]
}

/** The change the settings flags name (empty when none is given). Values are typed here; bounds are checked by the contract. */
function patchOf(ctx: CommandContext): LogsSettingsSet {
  const patch: LogsSettingsSet = {}
  const capture = ctx.string('capture-bodies')
  if (capture !== undefined) patch.captureBodies = onOff('capture-bodies', capture)
  const guest = ctx.string('guest-bodies')
  if (guest !== undefined) patch.guestBodies = onOff('guest-bodies', guest)
  const body = ctx.string('body-days')
  if (body !== undefined) patch.bodyRetentionDays = wholeNumber('body-days', body)
  const meta = ctx.string('meta-days')
  if (meta !== undefined) patch.metaRetentionDays = wholeNumber('meta-days', meta)
  const max = ctx.string('max-body-bytes')
  if (max !== undefined) patch.maxBodyBytes = wholeNumber('max-body-bytes', max)
  return patch
}

/** A change that breaks a bound or the bodies-no-longer-than-figures rule is refused before it is sent. */
function checkPatch(current: LogsSettings, patch: LogsSettingsSet): void {
  const bare = LogsSettingsSetSchema.safeParse(patch)
  if (!bare.success) throw new UsageError(bare.error.issues[0]?.message ?? 'bad logs setting')
  const merged = LogsSettingsSchema.safeParse({ ...current, ...patch })
  if (!merged.success) throw new UsageError(merged.error.issues[0]?.message ?? 'bad logs setting')
}

function kindOf(text: string | undefined): LlmSessionKind | undefined {
  if (text === undefined) return undefined
  const parsed = LlmSessionKindSchema.safeParse(text)
  if (!parsed.success)
    throw new UsageError(`--kind takes ${LlmSessionKindSchema.options.join(', ')}, not ${text}`)
  return parsed.data
}

const JSON_FLAG = {
  json: { type: 'boolean', description: 'Print the answer as JSON' },
} as const

/** `keith-core logs ...`: the model-call log, owner local (docs/specs/activity-logs.md). */
export function logsCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'logs',
    summary: 'Model-call log: list sessions and calls, raw bodies, settings, prune',
    subcommands: [
      defineCommand({
        name: 'list',
        summary: 'Sessions, newest first (figures only); another person is an audited read',
        flags: {
          kind: {
            type: 'string',
            description: 'Only one session kind (front, worker, dream, ...)',
          },
          person: {
            type: 'string',
            description: 'A username, or everyone (default: you)',
            placeholder: 'user',
          },
          model: { type: 'string', description: 'Only sessions whose primary model is this' },
          since: {
            type: 'string',
            description: 'From 12h, 7d or a date',
            placeholder: 'when',
          },
          limit: { type: 'string', description: 'At most this many rows (1 to 100)' },
          ...JSON_FLAG,
        },
        run: async (ctx) => {
          const kind = kindOf(ctx.string('kind'))
          const limit = ctx.string('limit')
          const since = ctx.string('since')
          const name = ctx.string('person')
          const { client } = await connectLocal(deps)
          // the procedures take a person id; the flag names a username (`everyone` is the owner's all-people list)
          const person =
            name === undefined || name === 'everyone'
              ? name
              : (await client.rpc.admin.people.get({ person: name })).id
          const out = await client.rpc.logs.sessions({
            ...(kind === undefined ? {} : { kind }),
            ...(person === undefined ? {} : { person }),
            ...(ctx.string('model') === undefined ? {} : { model: ctx.string('model') }),
            ...(since === undefined ? {} : { from: sinceOf(since, Date.now()) }),
            ...(limit === undefined ? {} : { limit: wholeNumber('limit', limit) }),
          })
          if (ctx.bool('json')) {
            printJson(ctx, out)
            return 0
          }
          printTable(
            ctx.io,
            out.sessions.map((s) => [
              when(s.lastAt),
              s.kind,
              s.app,
              s.id,
              s.primaryModel ?? '-',
              String(s.calls),
              usd(s.costMicro),
            ]),
            { header: ['LAST', 'KIND', 'APP', 'ID', 'MODEL', 'CALLS', 'COST'] },
          )
          if (out.nextCursor !== null)
            ctx.io.stdout.write('(more sessions: narrow with --since, --kind or --limit)\n')
          return 0
        },
      }),
      defineCommand({
        name: 'show',
        summary: 'One session: its overview and its generations (figures only)',
        usage: '<sessionId> [--json]',
        positionals: true,
        flags: { ...JSON_FLAG },
        run: async (ctx) => {
          const id = positional(ctx, 'session id (keith-core logs show <sessionId>)')
          const { client } = await connectLocal(deps)
          const out = await client.rpc.logs.session({ id })
          if (ctx.bool('json')) {
            printJson(ctx, out)
            return 0
          }
          for (const line of sessionLines(out)) ctx.io.stdout.write(`${line}\n`)
          printTable(
            ctx.io,
            out.generations.map((g) => [
              when(g.startedAt),
              g.kind,
              g.trigger ?? '-',
              g.modelId,
              g.status,
              ms(g.durationMs),
              String(g.tokensIn),
              String(g.tokensOut),
              usd(g.costMicro),
              g.id,
            ]),
            {
              header: [
                'TIME',
                'KIND',
                'TRIGGER',
                'MODEL',
                'STATUS',
                'LATENCY',
                'IN',
                'OUT',
                'COST',
                'ID',
              ],
            },
          )
          if (out.more) ctx.io.stdout.write('(more calls than listed)\n')
          return 0
        },
      }),
      defineCommand({
        name: 'call',
        summary: 'One call: its figures, the messages sent and the tool calls (no raw JSON)',
        usage: '<callId> [--json]',
        positionals: true,
        flags: { ...JSON_FLAG },
        run: async (ctx) => {
          const id = positional(ctx, 'call id (keith-core logs call <callId>)')
          const { client } = await connectLocal(deps)
          const out = await client.rpc.logs.call({ id })
          if (ctx.bool('json')) {
            printJson(ctx, out)
            return 0
          }
          printCall(ctx, out)
          return 0
        },
      }),
      defineCommand({
        name: 'raw',
        summary: 'The raw request or response JSON of one call (each read is audited)',
        usage: '<callId> [--part request|response] [--json]',
        positionals: true,
        flags: {
          part: { type: 'string', description: 'request or response (default: both)' },
          ...JSON_FLAG,
        },
        run: async (ctx) => {
          const id = positional(ctx, 'call id (keith-core logs raw <callId>)')
          const part = ctx.string('part')
          if (part !== undefined && part !== 'request' && part !== 'response')
            throw new UsageError(`--part takes request or response, not ${part}`)
          const { client } = await connectLocal(deps)
          const out = await client.rpc.logs.raw({ callId: id })
          if (ctx.bool('json')) {
            printJson(ctx, out)
            return 0
          }
          const parts = part === undefined ? ['request', 'response'] : [part]
          for (const name of parts) {
            const body = name === 'request' ? out.request : out.response
            if (parts.length > 1) ctx.io.stdout.write(`${name}:\n`)
            ctx.io.stdout.write(
              body === null ? `(not kept: bodies ${out.bodyState})\n` : `${body}\n`,
            )
          }
          if (out.truncated) ctx.io.stdout.write('(cut to the wire size)\n')
          return 0
        },
      }),
      defineCommand({
        name: 'settings',
        summary: 'Show or change the logs settings (no flag shows them; a change is audited)',
        flags: {
          'capture-bodies': { type: 'string', description: 'on or off', placeholder: 'on|off' },
          'guest-bodies': { type: 'string', description: 'on or off', placeholder: 'on|off' },
          'body-days': {
            type: 'string',
            description: 'Days to keep bodies (1 to 90)',
            placeholder: 'n',
          },
          'meta-days': {
            type: 'string',
            description: 'Days to keep figures (30 to 3650)',
            placeholder: 'n',
          },
          'max-body-bytes': {
            type: 'string',
            description: 'Body size cap before gzip (65536 to 4194304)',
            placeholder: 'n',
          },
        },
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const current = await client.rpc.logs.settings.get()
          const patch = patchOf(ctx)
          if (Object.keys(patch).length > 0) {
            checkPatch(current, patch)
            const after = await client.rpc.logs.settings.set(patch)
            printTable(ctx.io, settingRows(after), { header: ['SETTING', 'VALUE'] })
            return 0
          }
          printTable(ctx.io, settingRows(current), { header: ['SETTING', 'VALUE'] })
          return 0
        },
      }),
      defineCommand({
        name: 'prune',
        summary: 'Delete now what the retention would delete later (core must be stopped)',
        run: async (ctx) => {
          const config = configOf(deps)
          await requireOffline(config, 'logs prune')
          if (!existsSync(config.dbFile)) throw new CliError('no database yet: nothing to prune')
          const sqlite = openDatabase(config.dbFile)
          try {
            const settings = createActivityLogSettings(settingsRepo(sqlite)).get()
            const now = Date.now()
            const logs = activityLogsRepo(sqlite)
            // the same periods as the core's prune tick (platform/retention.ts): bodies, then figures
            const bodies = logs.purgeBodiesBefore(now - settings.bodyRetentionDays * DAY_MS)
            const meta = logs.purgeBefore(now - settings.metaRetentionDays * DAY_MS)
            const results = [
              { table: 'llm_bodies', count: bodies.bodies + meta.bodies },
              { table: 'llm_calls', count: meta.calls },
              { table: 'llm_sessions', count: meta.sessions },
            ]
            const audit = createAudit(auditRepo(sqlite))
            for (const { table, count } of results) {
              if (count > 0)
                audit.record({
                  kind: 'data.pruned',
                  actor: 'system',
                  via: 'local',
                  detail: { table, count },
                })
            }
            printTable(
              ctx.io,
              results.map((r) => [r.table, String(r.count)]),
              {
                header: ['TABLE', 'DELETED'],
              },
            )
          } finally {
            sqlite.close()
          }
          return 0
        },
      }),
    ],
  })
}
