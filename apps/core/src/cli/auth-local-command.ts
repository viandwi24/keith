import { type CommandContext, confirm, isInteractive, UsageError } from '@keith/cli'
import {
  DEFAULT_LOCAL_TRUST,
  IDLE_MINUTES_MAX,
  type LocalAccessView,
  type LocalTrust,
  LocalTrustSchema,
} from '@keith/contracts'
import { secretsRepo } from '@keith/db'
import { trustNoneProblem } from '../modules/admin/auth-local.ts'
import { withOfflineAdmin } from '../modules/admin/index.ts'
import { createPolicyStore, LOCAL_SETTING } from '../modules/auth/index.ts'
import { probeSocket, socketPathFor } from '../modules/local-socket/index.ts'
import { type CliDeps, configOf, connectLocal, requireOffline } from './context.ts'

const FULL_WARNING = `Full trust means anyone who sits at this machine with your user account unlocked is you:
Keith serves the owner on the local socket with no PIN, no password and no idle-lock.
A visitor at the keyboard, a script or a program running as you can read your data and run admin commands.`

const NONE_NOTE = `Local trust is now "none": the socket serves no implicit owner.
- keith-core commands ask for your PIN (or password) each time; \`eval "$(keith-core login)"\` keeps a 5-minute session in this shell only.
- keith opens on the Sign in panel for the socket; a script that talked to the socket with no credential now gets 401.
- Forgot the PIN? Stop the core and run: keith-core auth local set --trust full --yes (then set a PIN and go back to none)`

/** The lock line of \`auth local show\`. */
export function describeLocal(view: LocalAccessView): string {
  const lines = [`local trust: ${view.trust}`]
  if (view.trust === 'none') {
    lines.push('local socket: needs a session (no implicit owner, no idle-lock)')
  } else if (!view.hasPin) {
    lines.push('local socket lock: off: the owner has no PIN (keith-core people pin <owner>)')
  } else if (view.trust === 'full') {
    lines.push('local socket lock: never by idleness (`keith lock` still works)')
  } else {
    lines.push(
      view.idleMinutes === 0
        ? 'local socket lock: on, never by idleness (`keith lock` still works)'
        : `local socket lock: on, after ${view.idleMinutes} idle minutes`,
    )
  }
  return `${lines.join('\n')}${view.locked ? '\n[locked now]' : ''}\n`
}

/** `keith-core auth local show|set|reset` (docs/specs/auth.md, "The local socket"). */
export async function localCommand(
  ctx: CommandContext,
  deps: CliDeps,
  action: string | undefined,
): Promise<number> {
  if (action === 'reset') return reset(ctx, deps)
  if (action !== 'show' && action !== 'set')
    throw new UsageError(
      'usage: auth local show | set [--trust <level>] [--idle-minutes <n>] | reset',
    )
  const person = ctx.string('person')
  if (action === 'show') {
    const { client } = await connectLocal(deps)
    ctx.io.stdout.write(describeLocal(await client.rpc.admin.auth.local.get({ person })))
    return 0
  }
  const rawMinutes = ctx.string('idle-minutes')
  const minutes = rawMinutes === undefined ? undefined : Number(rawMinutes)
  if (
    minutes !== undefined &&
    (!Number.isInteger(minutes) || minutes < 0 || minutes > IDLE_MINUTES_MAX)
  )
    throw new UsageError(`--idle-minutes must be a whole number from 0 to ${IDLE_MINUTES_MAX}`)
  const rawTrust = ctx.string('trust')
  const parsed = rawTrust === undefined ? undefined : LocalTrustSchema.safeParse(rawTrust)
  if (parsed !== undefined && !parsed.success)
    throw new UsageError('--trust must be none, idle-lock or full')
  const trust: LocalTrust | undefined = parsed?.success ? parsed.data : undefined
  if (trust === undefined && minutes === undefined)
    throw new UsageError('give --trust <none|idle-lock|full> and/or --idle-minutes <n>')
  let acknowledge: boolean | undefined
  if (trust === 'full') {
    ctx.io.stdout.write(`${FULL_WARNING}\n`)
    acknowledge =
      ctx.bool('yes') ||
      (isInteractive(ctx.io) &&
        (await confirm('Set full trust anyway?', { default: false, io: ctx.io })))
    if (!acknowledge)
      throw new UsageError(
        isInteractive(ctx.io)
          ? 'not changed'
          : 'full trust needs --yes (you have read the warning above)',
      )
  }
  if (!(await probeSocket(socketPathFor(configOf(deps).dataDir))))
    return setOffline(ctx, deps, { trust, minutes, acknowledge, person })
  const { client } = await connectLocal(deps)
  const view = await client.rpc.admin.auth.local.set({
    ...(person === undefined ? {} : { person }),
    ...(trust === undefined ? {} : { trust }),
    ...(minutes === undefined ? {} : { idleMinutes: minutes }),
    ...(acknowledge === true ? { acknowledge: true } : {}),
  })
  ctx.io.stdout.write(describeLocal(view))
  if (trust === 'none') ctx.io.stdout.write(`${NONE_NOTE}\n`)
  return 0
}

/** Core stopped: forget the stored local settings (trust back to the default, idle minutes to 15). */
async function reset(ctx: CommandContext, deps: CliDeps): Promise<number> {
  const config = configOf(deps)
  await requireOffline(config, 'auth local reset')
  const had = await withOfflineAdmin(config, { migrate: false, ...deps.offline }, async (admin) => {
    const stored = admin.settings.get<unknown>(LOCAL_SETTING) !== undefined
    admin.settings.delete(LOCAL_SETTING)
    admin.audit.add({
      kind: 'auth.local.reset',
      actor: 'system',
      via: 'offline',
      detail: { hadStoredSettings: stored },
    })
    return stored
  })
  ctx.io.stdout.write(
    had
      ? `the stored local socket settings were removed: trust is "${DEFAULT_LOCAL_TRUST}" and the idle-lock is 15 minutes again\n`
      : 'no stored local socket settings: the defaults already apply\n',
  )
  return 0
}

/** Core stopped: change the owner's trust level and idle minutes in the database (audited, `via: offline`). */
async function setOffline(
  ctx: CommandContext,
  deps: CliDeps,
  want: {
    trust: LocalTrust | undefined
    minutes: number | undefined
    acknowledge: boolean | undefined
    person: string | undefined
  },
): Promise<number> {
  if (want.person !== undefined)
    throw new UsageError('--person works with the core running; offline this changes the owner')
  const config = configOf(deps)
  await requireOffline(config, 'auth local set')
  const message = await withOfflineAdmin(
    config,
    { migrate: false, ...deps.offline },
    async (admin) => {
      const owner = admin.tokens.owner()
      if (owner === undefined) throw new UsageError('no owner yet: run `keith-core setup`')
      if (want.trust === 'none') {
        const problem = trustNoneProblem(
          secretsRepo(admin.sqlite).kinds(owner.id),
          createPolicyStore(admin.settings).get(),
        )
        if (problem !== undefined) throw new UsageError(problem)
      }
      const raw = admin.settings.get<{ idleMinutes?: number; trust?: Record<string, LocalTrust> }>(
        LOCAL_SETTING,
      )
      const before = raw?.trust?.[owner.id] ?? DEFAULT_LOCAL_TRUST
      admin.settings.set(LOCAL_SETTING, {
        ...raw,
        ...(want.minutes === undefined ? {} : { idleMinutes: want.minutes }),
        ...(want.trust === undefined ? {} : { trust: { ...raw?.trust, [owner.id]: want.trust } }),
      })
      admin.audit.add({
        kind: 'auth.local.set',
        actor: 'system',
        via: 'offline',
        detail: {
          personId: owner.id,
          ...(want.trust === undefined ? {} : { trust: want.trust, wasTrust: before }),
          ...(want.minutes === undefined ? {} : { idleMinutes: want.minutes }),
          ...(want.trust === 'full' && want.acknowledge === true ? { acknowledged: true } : {}),
        },
      })
      return `local trust of ${owner.username ?? owner.id}: ${want.trust ?? before} (the core was stopped: it applies at the next start)\n`
    },
  )
  ctx.io.stdout.write(message)
  return 0
}
