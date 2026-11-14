import {
  ask,
  askHidden,
  CliError,
  type CommandContext,
  confirm,
  defineCommand,
  printNextSteps,
  select,
  UsageError,
} from '@keith/cli'
import type { AccessMode, PrimaryModelRole } from '@keith/contracts'
import { LockHeldError, type OfflineAdmin, openOfflineAdmin } from '../modules/admin/index.ts'
import { createHasher } from '../modules/auth/index.ts'
import { type CliDeps, configOf, requireOffline } from './context.ts'
import { budgetFlag, wantsPrompts } from './prompt-helpers.ts'
import { stepOwnerSignIn, stepOwnerUsername } from './setup-owner.ts'
import {
  budgetDefault,
  budgetHeadless,
  budgetProblem,
  currentNetwork,
  currentOwnerName,
  ENV_KEYS,
  isUrl,
  knownModels,
  markSetupDone,
  modelChecker,
  modelRef,
  modelSuggestion,
  NEXT_STEPS,
  nonEmpty,
  probeProvider,
  putProvider,
  ROLES,
  SETUP_PROVIDERS,
  type SetupSummary,
  safeUser,
  saveAccess,
  saveBudget,
  saveOwnerName,
  saveRole,
  summaryLines,
  urlProblem,
} from './setup-steps.ts'
import { runSetupWizard, wizardWanted } from './setup-wizard-run.tsx'

export function setupCommand(deps: CliDeps) {
  return defineCommand({
    name: 'setup',
    summary: 'Name, AI provider, models, budget and access (core must be stopped)',
    flags: {
      'owner-name': { type: 'string', placeholder: 'name', description: 'Your name' },
      provider: {
        type: 'string',
        placeholder: 'id',
        description: 'openrouter, openai, deepseek or skip',
      },
      'api-key-stdin': { type: 'boolean', description: 'Read the provider API key from stdin' },
      'skip-test': { type: 'boolean', description: 'Save the provider without testing it' },
      'front-model': { type: 'string', placeholder: 'id', description: 'Model of the front agent' },
      'cortex-model': {
        type: 'string',
        placeholder: 'id',
        description: 'Model of the cortex workers',
      },
      budget: { type: 'string', placeholder: 'usd|none', description: 'Monthly budget in USD' },
      access: { type: 'string', placeholder: 'local|remote', description: 'Who can reach core' },
      'public-url': { type: 'string', placeholder: 'url', description: 'URL of other devices' },
      bind: { type: 'string', placeholder: 'host', description: 'Bind address (default: derived)' },
      'owner-username': {
        type: 'string',
        placeholder: 'name',
        description: 'The username the owner signs in with (default owner)',
      },
      'owner-pin-stdin': {
        type: 'boolean',
        description: 'Read the owner PIN (6 to 12 digits) from stdin, after the API key',
      },
      'owner-password-stdin': {
        type: 'boolean',
        description: 'Read the owner password from stdin, after the PIN',
      },
      'non-interactive': { type: 'boolean', description: 'Never prompt; missing answers fail' },
    },
    examples: [
      'keith-core setup',
      'printf "%s\\n%s\\n" "$KEY" "$PIN" | keith-core setup --non-interactive --owner-name Vian --provider openrouter --api-key-stdin --owner-pin-stdin',
    ],
    run: (ctx) => runSetup(ctx, deps),
  })
}

async function runSetup(ctx: CommandContext, deps: CliDeps): Promise<number> {
  const { io } = ctx
  const config = configOf(deps)
  await requireOffline(config, 'setup')
  const prompts = wantsPrompts(io, ctx.bool('non-interactive'))
  if (prompts && wizardWanted(ctx)) {
    const outcome = await runSetupWizard(io, deps, config)
    if (outcome.status === 'saved') printSaved(io, outcome.summary)
    else io.stdout.write('Setup cancelled; nothing was saved.\n')
    return 0
  }
  let admin: OfflineAdmin
  try {
    admin = await openOfflineAdmin(config, { migrate: true, ...deps.offline })
  } catch (error) {
    if (error instanceof LockHeldError) throw new CliError(`${error.message}; stop it first`)
    throw error
  }
  try {
    io.stdout.write('Keith setup. Press Enter to keep a value shown in brackets.\n')
    // the username first: a refused one changes nothing (FD10-03)
    await stepOwnerUsername(ctx, admin, prompts)
    const owner = await stepName(ctx, admin, prompts)
    const connection = await stepProvider(ctx, admin, prompts, config.providerEnv)
    const models =
      connection === undefined ? undefined : await stepModels(ctx, admin, prompts, connection)
    const budget = await stepBudget(ctx, admin, prompts)
    const access = await stepAccess(ctx, admin, prompts, config)
    // required: without a PIN or a password nobody could sign in to the socket
    const hasher = deps.hasher === undefined ? undefined : createHasher(deps.hasher)
    const signIn = await stepOwnerSignIn(ctx, admin, prompts, hasher)
    markSetupDone(admin)

    printSaved(io, { owner, connection, models, budget, access, signIn })
    return 0
  } finally {
    admin.close()
  }
}

/** The "Saved for ..." block and the next steps (shared with the wizard path). */
export function printSaved(io: CommandContext['io'], summary: SetupSummary): void {
  for (const line of summaryLines(summary)) io.stdout.write(line)
  printNextSteps(io, NEXT_STEPS)
}

async function stepName(
  ctx: CommandContext,
  admin: OfflineAdmin,
  prompts: boolean,
): Promise<string> {
  const current = currentOwnerName(admin)
  let name = ctx.string('owner-name')
  if (name === undefined) {
    if (prompts) {
      name = await ask('Your name', {
        default: current ?? safeUser(),
        validate: (v) => (v === '' ? 'a name is needed' : undefined),
      })
    } else if (current !== undefined) name = current
    else throw new UsageError('missing --owner-name')
  }
  name = name.trim()
  if (name === '' || name.length > 60)
    throw new UsageError('--owner-name must be 1 to 60 characters')
  await saveOwnerName(admin, name)
  return name
}

/** Returns the id of the connection to use, or undefined when the provider step is skipped. */
async function stepProvider(
  ctx: CommandContext,
  admin: OfflineAdmin,
  prompts: boolean,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  const { providers } = admin
  const { io } = ctx
  const described = await providers.describe()
  const connections = await providers.list()
  const current = connections.find((c) => c.enabled)
  let pid = ctx.string('provider')
  if (pid === undefined) {
    if (prompts) {
      const labels = (id: string, fallback: string) =>
        described.find((d) => d.id === id)?.label ?? fallback
      const choice = await select(
        'AI provider',
        [
          ...SETUP_PROVIDERS.map((id) => ({
            value: id as string,
            label: labels(id, id),
            ...(env[ENV_KEYS[id] ?? '']
              ? { hint: `${ENV_KEYS[id]} found in the environment` }
              : {}),
          })),
          { value: 'skip', label: 'Skip for now', hint: 'add one later: keith-core provider add' },
        ],
        { default: current?.providerId ?? 'openrouter' },
      )
      pid = choice
    } else if (current !== undefined) pid = current.providerId
    else throw new UsageError('missing --provider (openrouter, openai, deepseek or skip)')
  }
  if (pid === 'skip') return current?.id
  const description = described.find((d) => d.id === pid)
  if (description === undefined) {
    throw new UsageError(
      `unknown provider ${pid} (known: ${described.map((d) => d.id).join(', ')})`,
    )
  }
  const existing = connections.find((c) => c.id === pid)
  const hasKeyField = description.fields.some((f) => f.path === 'apiKey' && f.secret)
  const envVar = ENV_KEYS[pid]
  const envKey = envVar === undefined ? undefined : env[envVar]

  for (let attempt = 0; attempt < 3; attempt++) {
    let key: string | undefined
    let useExisting = false
    if (hasKeyField) {
      if (ctx.bool('api-key-stdin')) {
        key = await askHidden(`${description.label} API key`, { io, validate: nonEmpty })
      } else if (existing?.source === 'env' || (envKey !== undefined && existing === undefined)) {
        const use = prompts
          ? await confirm(`Use ${envVar} from the environment?`, { default: true, io })
          : true
        if (use) useExisting = true
        else key = await askHidden(`${description.label} API key`, { io, validate: nonEmpty })
      } else if (existing !== undefined) {
        const keep = prompts
          ? await confirm(`Keep the saved ${description.label} key?`, { default: true, io })
          : true
        if (keep) useExisting = true
        else key = await askHidden(`${description.label} API key`, { io, validate: nonEmpty })
      } else if (prompts) {
        key = await askHidden(`${description.label} API key`, { io, validate: nonEmpty })
      } else throw new UsageError('missing --api-key-stdin (or set the key in the environment)')
    } else if (existing !== undefined) useExisting = true

    const settings = key === undefined ? undefined : { apiKey: key }
    const save = async (): Promise<void> => {
      if (useExisting) return
      await putProvider(admin, { pid, exists: existing !== undefined, settings })
      if (envKey !== undefined) {
        io.stdout.write(`note: ${envVar} is set and takes precedence over the saved key\n`)
      }
    }
    if (ctx.bool('skip-test')) {
      await save()
      return pid
    }
    // test a new key under a probe id first: nothing real is written until it works
    const result = await probeProvider(providers, { pid, settings, useExisting })
    if (result.ok) {
      await save()
      io.stdout.write(`${description.label}: connection works\n`)
      return pid
    }
    const why = result.message ?? 'no answer'
    if (!prompts) throw new CliError(`provider ${pid} failed its connection test: ${why}`)
    io.stdout.write(`${description.label}: connection failed (${why})\n`)
    if (await confirm('Save it anyway?', { default: false, io })) {
      await save()
      return pid
    }
    if (!(await confirm('Try another key?', { default: true, io }))) return current?.id
  }
  throw new CliError(`provider ${pid} failed its connection test three times`)
}

async function stepModels(
  ctx: CommandContext,
  admin: OfflineAdmin,
  prompts: boolean,
  connection: string,
): Promise<Record<PrimaryModelRole, string>> {
  const { providers } = admin
  const { io } = ctx
  const known = await knownModels(providers, connection)
  if (known === undefined) {
    io.stdout.write('note: could not list the provider models; ids are not checked\n')
  }
  const check = modelChecker(connection, known ?? [])
  const providerId = (await providers.list()).find((c) => c.id === connection)?.providerId
  const out = {} as Record<PrimaryModelRole, string>
  for (const role of ROLES) {
    const given = ctx.string(role === 'front' ? 'front-model' : 'cortex-model')
    const suggestion = await modelSuggestion(providers, { connection, providerId, role })
    let value = given
    if (value === undefined) {
      if (prompts) {
        value = await ask(`${role === 'front' ? 'Front' : 'Cortex'} model`, {
          ...(suggestion === undefined ? {} : { default: suggestion }),
          validate: check,
        })
      } else if (suggestion !== undefined) value = suggestion
      else throw new UsageError(`missing --${role}-model`)
    }
    const problem = check(value)
    if (problem !== undefined) throw new CliError(problem)
    const ref = modelRef(connection, value)
    await saveRole(admin, role, ref)
    out[role] = ref
  }
  return out
}

async function stepBudget(
  ctx: CommandContext,
  admin: OfflineAdmin,
  prompts: boolean,
): Promise<number | null> {
  const flag = ctx.string('budget')
  let limit: number | null
  if (flag !== undefined) limit = budgetFlag(flag)
  else if (prompts) {
    const typed = await ask('Monthly budget in USD (or none)', {
      default: budgetDefault(admin),
      validate: budgetProblem,
    })
    limit = budgetFlag(typed)
  } else limit = budgetHeadless(admin)
  saveBudget(admin, limit)
  return limit
}

async function stepAccess(
  ctx: CommandContext,
  admin: OfflineAdmin,
  prompts: boolean,
  config: ReturnType<typeof configOf>,
): Promise<string> {
  const net = currentNetwork(config, admin)
  let mode = ctx.string('access') as AccessMode | undefined
  if (mode !== undefined && mode !== 'local' && mode !== 'remote') {
    throw new UsageError('--access must be local or remote')
  }
  if (mode === undefined) {
    mode = prompts
      ? ((await select<AccessMode>(
          'Who will use Keith',
          [
            { value: 'local', label: 'Only this computer' },
            {
              value: 'remote',
              label: 'Also my other devices',
              hint: 'Tailscale recommended: tailscale serve, or the tailnet address',
            },
          ],
          { default: net.mode, io: ctx.io },
        )) as AccessMode)
      : net.mode
  }
  let publicUrl = net.publicUrl
  const given = ctx.string('public-url')
  if (mode === 'local') {
    publicUrl = given
  } else if (given !== undefined) publicUrl = given
  else if (prompts) {
    const typed = await ask('URL your devices use to reach core (Enter for none yet)', {
      default: net.publicUrl ?? '',
      validate: urlProblem,
    })
    publicUrl = typed === '' ? undefined : typed
  }
  if (publicUrl !== undefined && !isUrl(publicUrl))
    throw new UsageError('--public-url must be a URL')
  return saveAccess(admin, { mode, publicUrl, bind: ctx.string('bind') })
}
