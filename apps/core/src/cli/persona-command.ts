// `keith-core persona show|template|history` (docs/specs/prefrontal.md "CLI", core-cli.md, cli.md, P33.2.6). `show` and `history`
// read the database straight (read only, offline-safe: never the socket). `template <id>` changes the persona through the running
// core (`persona.setTemplate`), which checks the owner and writes the version and the audit row; without `--yes` it changes nothing.
// The data folder is the owner's: whoever runs this on the machine is the owner, as with `rooms end`.
import {
  CliError,
  type Command,
  defineCommand,
  printTable,
  stripControl,
  UsageError,
} from '@keith/cli'
import {
  BUILTIN_PERSONA_TEMPLATE_IDS,
  PersonaTemplateSchema,
  type PersonaVersion,
} from '@keith/contracts'
import { personaRepo, type Sqlite } from '@keith/db'
import { dbState, openKeithDatabaseReadOnly, refusalOf } from '../platform/db.ts'
import { type CliDeps, configOf, connectLocal } from './context.ts'

const isoOf = (ms: number): string => new Date(ms).toISOString()

/** Runs `use` on the database read only; refused with the reason when it is missing, behind, ahead or unreadable. */
async function withPersona<T>(deps: CliDeps, use: (sqlite: Sqlite) => T): Promise<T> {
  const config = configOf(deps)
  const state = dbState(config.dbFile)
  if (state.kind === 'missing')
    throw new CliError('this data folder is not set up: run `keith-core setup`')
  const refusal = refusalOf(state, config)
  if (refusal !== undefined) throw new CliError(refusal)
  if (state.kind !== 'ready')
    throw new CliError('the database is behind: run `keith-core db migrate`')
  const sqlite = await openKeithDatabaseReadOnly(config.dbFile)
  try {
    return use(sqlite)
  } finally {
    sqlite.close()
  }
}

/** The directory's names by id; a person the directory no longer has keeps their id. */
function nameLookup(sqlite: Sqlite): (id: string) => string {
  const byId = sqlite.query<{ name: string }, [string]>('SELECT name FROM people WHERE id = ?')
  return (id) => {
    const row = byId.get(id)
    return row === null ? id : stripControl(row.name)
  }
}

const NO_PERSONA = 'there is no persona yet: start the core once so the first boot seeds it'

function showCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'show',
    summary: 'The current persona: template, version and its text (works offline)',
    usage: 'show',
    run: async (ctx) => {
      const view = await withPersona(deps, (sqlite) => personaRepo(sqlite).get())
      if (view === undefined) throw new CliError(NO_PERSONA)
      const lines = [
        `version: ${view.version}`,
        `template: ${view.templateId}`,
        `updated: ${isoOf(view.updatedAt)}`,
        `tone: ${stripControl(view.body.tone)}`,
        `attitude: ${stripControl(view.body.attitude)}`,
        `humour: ${view.body.humour}`,
        `addressing: ${stripControl(view.body.addressing)}`,
        `cares about: ${stripControl(view.body.caresAbout)}`,
        `answer failed: ${stripControl(view.body.lines.answerFailed)}`,
        `guest unavailable: ${stripControl(view.body.lines.guestUnavailable)}`,
      ]
      for (const line of lines) ctx.io.stdout.write(`${line}\n`)
      return 0
    },
  })
}

function historyCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'history',
    summary: 'Every version of the persona, newest first (works offline)',
    usage: 'history',
    run: async (ctx) => {
      const rows = await withPersona(deps, (sqlite) => {
        const name = nameLookup(sqlite)
        return personaRepo(sqlite)
          .versions(200)
          .map((v: PersonaVersion) => [
            String(v.version),
            isoOf(v.changedAt),
            v.reason,
            v.templateId,
            name(v.changedBy),
          ])
      })
      if (rows.length === 0) throw new CliError(NO_PERSONA)
      printTable(ctx.io, rows, { header: ['VERSION', 'CHANGED', 'REASON', 'TEMPLATE', 'BY'] })
      return 0
    },
  })
}

function templateCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'template',
    summary: 'Switch the persona to a built-in template (owner; needs --yes)',
    usage: 'template <id> --yes',
    positionals: true,
    flags: {
      yes: {
        type: 'boolean',
        description: 'Confirm the switch; without it nothing changes',
      },
    },
    run: async (ctx) => {
      const [id] = ctx.positionals
      if (ctx.positionals.length !== 1 || id === undefined || id === '')
        throw new UsageError('usage: persona template <id> --yes')
      const template = PersonaTemplateSchema.safeParse(id)
      if (!template.success)
        throw new UsageError(
          `there is no template ${stripControl(id)}: use ${BUILTIN_PERSONA_TEMPLATE_IDS.join(', ')}`,
        )
      if (!ctx.bool('yes')) {
        ctx.io.stdout.write(
          `nothing changed: add --yes to switch the persona to ${template.data}\n`,
        )
        return 0
      }
      const { client } = await connectLocal(deps)
      const view = await client.rpc.persona.setTemplate({ templateId: template.data })
      ctx.io.stdout.write(`persona set to ${view.templateId} (version ${view.version})\n`)
      return 0
    },
  })
}

/** `keith-core persona show|template|history`: the persona of the core (docs/specs/prefrontal.md). */
export function personaCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'persona',
    summary: 'The persona: show it, switch its template (owner), or list its history',
    subcommands: [showCommand(deps), templateCommand(deps), historyCommand(deps)],
  })
}
