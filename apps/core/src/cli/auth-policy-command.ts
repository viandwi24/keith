import { readFile } from 'node:fs/promises'
import { CliError, type Command, defineCommand, UsageError } from '@keith/cli'
import { AuthPolicyInputSchema } from '@keith/contracts'
import { withOfflineAdmin } from '../modules/admin/index.ts'
import { POLICY_SETTING } from '../modules/auth/index.ts'
import { localCommand } from './auth-local-command.ts'
import { type CliDeps, configOf, connectLocal, requireOffline } from './context.ts'

/**
 * `keith-core auth policy show|set|reset` (docs/specs/auth.md, "Policy"). `show` and `set` talk to the
 * running core over the socket (`admin.auth.policy.*`, audited, with the lockout guard); `reset` works
 * with the core stopped, like `token recover`, and is the way back from a policy that locks you out.
 */
export function authCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'auth',
    summary: 'The sign-in policy: which methods work from which network',
    usage:
      'policy show | policy set --file <policy.json> | policy reset | local show | local set [--trust <level>] [--idle-minutes <n>] | local reset',
    positionals: true,
    flags: {
      file: { type: 'string', placeholder: 'path', description: 'A policy as JSON (policy set)' },
      'idle-minutes': {
        type: 'string',
        placeholder: 'n',
        description: 'Minutes idle before the local socket locks; 0 = never (local set)',
      },
      trust: {
        type: 'string',
        placeholder: 'level',
        description:
          'none, idle-lock or full: how far the local socket trusts the keyboard (local set)',
      },
      person: {
        type: 'string',
        placeholder: 'username',
        description: 'Whose trust level (default: you; local show|set)',
      },
      yes: { type: 'boolean', description: 'Confirm `--trust full` without asking (local set)' },
    },
    run: async (ctx) => {
      const [area, action] = ctx.positionals
      if (area === 'local') return localCommand(ctx, deps, action)
      if (area !== 'policy')
        throw new UsageError('usage: auth policy show | set --file <f> | reset | local show | set')
      if (action === 'show') {
        const { client } = await connectLocal(deps)
        const view = await client.rpc.admin.auth.policy.get()
        ctx.io.stdout.write(
          `${view.isDefault ? '# the built-in default (nothing stored)\n' : ''}${JSON.stringify(view.policy, null, 2)}\n`,
        )
        return 0
      }
      if (action === 'set') {
        const file = ctx.string('file')
        if (file === undefined) throw new UsageError('missing --file <policy.json>')
        let parsed: unknown
        try {
          parsed = JSON.parse(await readFile(file, 'utf8'))
        } catch {
          throw new CliError(`cannot read a JSON policy from ${file}`)
        }
        const policy = AuthPolicyInputSchema.safeParse(parsed)
        if (!policy.success) {
          throw new CliError(
            `not a valid policy: ${policy.error.issues[0]?.message ?? 'see the spec'}`,
          )
        }
        const { client } = await connectLocal(deps)
        const view = await client.rpc.admin.auth.policy.set(policy.data)
        ctx.io.stdout.write(`policy stored (${view.policy.rules.length} rules)\n`)
        return 0
      }
      if (action === 'reset') {
        const config = configOf(deps)
        await requireOffline(config, 'auth policy reset')
        const had = await withOfflineAdmin(
          config,
          { migrate: false, ...deps.offline },
          async (admin) => {
            const stored = admin.settings.get<unknown>(POLICY_SETTING) !== undefined
            admin.settings.delete(POLICY_SETTING)
            admin.audit.add({
              kind: 'auth.policy.reset',
              actor: 'system',
              via: 'offline',
              detail: { hadStoredPolicy: stored },
            })
            return stored
          },
        )
        ctx.io.stdout.write(
          had
            ? 'the stored policy was removed: the built-in default applies\n'
            : 'no stored policy: the built-in default already applies\n',
        )
        return 0
      }
      throw new UsageError('usage: auth policy show | set --file <f> | reset')
    },
  })
}
