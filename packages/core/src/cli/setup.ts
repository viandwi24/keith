// `keith setup`: creates KEITH_HOME, config.toml, persona.md, the database and the owner person.
// Safe to run again: existing files are kept, and an existing owner is offered a password reset.
// See docs/architecture/config.md and docs/architecture/nodes.md#auth-phase-1.

import { mkdir } from 'node:fs/promises'
import { KeithError } from '@keith/sdk'
import { defaultPersona, keithPaths } from '../config/index.ts'
import type { KeithPaths } from '../config/types.ts'
import { createIds } from '../shared/index.ts'
import type { Clock, PersonId } from '../shared/types.ts'
import { openDb } from '../storage/index.ts'
import type { PersonsRepository } from '../storage/types.ts'
import type { Prompter } from './prompt.ts'

export type ProviderChoice = {
  key: 'deepseek' | 'openrouter'
  label: string
  /** Plugin package (= plugin id). */
  pluginId: string
  /** Provider id used in model refs. */
  providerId: string
  envVar: string
  /** Offered as the default model id. Vendor ids change; the prompt says so. */
  defaultModel: string
  /** Extra plugin config lines. */
  extra: string[]
}

export const PROVIDER_CHOICES: readonly ProviderChoice[] = [
  {
    key: 'deepseek',
    label: 'DeepSeek',
    pluginId: '@keith/provider-deepseek',
    providerId: 'deepseek',
    envVar: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-flash',
    extra: [],
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    pluginId: '@keith/provider-openrouter',
    providerId: 'openrouter',
    envVar: 'OPENROUTER_API_KEY',
    defaultModel: '~openai/gpt-sol-latest',
    extra: ['appTitle = "Keith"'],
  },
]

/** The config.toml `keith setup` writes: only the chosen provider, every role on one model. */
export function renderConfig(choice: ProviderChoice, model: string): string {
  const ref = JSON.stringify(`${choice.providerId}:${model}`)
  const plugin = JSON.stringify(choice.pluginId)
  return [
    '# Keith configuration. Every key and its default: docs/architecture/config.md',
    '',
    '[server]',
    'host = "127.0.0.1"',
    'port = 4824',
    '',
    '[models]                           # "<providerId>:<modelId>"; split roles across models freely',
    `foreground = ${ref}`,
    `background = ${ref}`,
    `utility    = ${ref}`,
    '',
    '[plugins]',
    `enabled  = [${plugin}]`,
    `required = [${plugin}]`,
    '',
    `[plugins.${plugin}]`,
    `apiKey = ${JSON.stringify(`env:${choice.envVar}`)}`,
    ...choice.extra,
    '',
  ].join('\n')
}

export type SetupOptions = {
  home: string
  prompter: Prompter
  /** Prints one line for the person. */
  out: (line: string) => void
  clock: Clock
}

export type SetupResult = {
  paths: KeithPaths
  configWritten: boolean
  personaWritten: boolean
  owner: { id: PersonId; username: string; created: boolean; passwordReset: boolean }
}

const MIN_PASSWORD = 8

export async function runSetup(opts: SetupOptions): Promise<SetupResult> {
  const { prompter, out } = opts
  const paths = keithPaths(opts.home)
  for (const dir of [paths.home, paths.filesDir, paths.pluginsDir, paths.logsDir]) {
    await mkdir(dir, { recursive: true })
  }
  out(`Keith home: ${paths.home}`)

  const configFile = Bun.file(paths.configFile)
  let configWritten = false
  let choice: ProviderChoice | undefined
  if (await configFile.exists()) {
    out(`Keeping the existing ${paths.configFile}`)
  } else {
    choice = await askProvider(prompter)
    const model = await askNonEmpty(
      prompter,
      `Model id for ${choice.label} (the default may be outdated; check ${choice.label}'s model list)`,
      choice.defaultModel,
    )
    await Bun.write(paths.configFile, renderConfig(choice, model))
    configWritten = true
    out(`Wrote ${paths.configFile}`)
  }

  let personaWritten = false
  if (await Bun.file(paths.personaFile).exists()) {
    out(`Keeping the existing ${paths.personaFile}`)
  } else {
    await Bun.write(paths.personaFile, defaultPersona(await mindName(paths.configFile)))
    personaWritten = true
    out(`Wrote ${paths.personaFile}`)
  }

  const db = openDb(paths.dbFile)
  try {
    out(`Database ready: ${paths.dbFile}`)
    const owner = await ensureOwner(db.repos.persons, opts)
    if (choice) {
      out('')
      out(
        `Next: export ${choice.envVar}=<your key>, run 'keith start', then 'keith-tui' in another terminal.`,
      )
    }
    return { paths, configWritten, personaWritten, owner }
  } finally {
    db.close()
  }
}

async function ensureOwner(persons: PersonsRepository, opts: SetupOptions): Promise<SetupResult['owner']> {
  const { prompter, out } = opts
  const existing = (await persons.list()).find((p) => p.tier === 'owner')
  if (existing) {
    const username = existing.username ?? existing.name
    out(`Owner: ${existing.name} (${username})`)
    const reset = await askYesNo(prompter, `Reset the password of ${username}?`, false)
    if (reset) {
      const password = await askNewPassword(prompter)
      await persons.setPasswordHash(existing.id, await Bun.password.hash(password))
      out('Password changed.')
    }
    return { id: existing.id, username, created: false, passwordReset: reset }
  }

  out('Create the owner account.')
  const name = await askNonEmpty(prompter, 'Your name')
  let username = ''
  for (;;) {
    username = await askNonEmpty(prompter, 'Username', name.toLowerCase().replace(/\s+/g, '-'))
    if ((await persons.getByUsername(username)) === null) break
    out(`The username ${username} is taken.`)
  }
  const password = await askNewPassword(prompter)
  const id = createIds({ clock: opts.clock }).next('per')
  await persons.create({
    id,
    name,
    username,
    passwordHash: await Bun.password.hash(password),
    tier: 'owner',
    lastSeenAt: null,
    createdAt: opts.clock.now(),
  })
  out(`Created the owner ${name} (${username}).`)
  return { id, username, created: true, passwordReset: false }
}

async function askProvider(prompter: Prompter): Promise<ProviderChoice> {
  const options = PROVIDER_CHOICES.map((c, i) => `${i + 1}) ${c.label}`).join('  ')
  for (;;) {
    const answer = (await prompter.ask(`LLM provider: ${options}`, '1')).trim().toLowerCase()
    const byNumber = PROVIDER_CHOICES[Number(answer) - 1]
    const found = byNumber ?? PROVIDER_CHOICES.find((c) => c.key === answer)
    if (found) return found
  }
}

async function askNonEmpty(prompter: Prompter, question: string, fallback?: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const answer = (await prompter.ask(question, fallback)).trim()
    if (answer !== '') return answer
  }
  throw new KeithError('INTERNAL', `no answer for: ${question}`)
}

async function askYesNo(prompter: Prompter, question: string, fallback: boolean): Promise<boolean> {
  const answer = (await prompter.ask(`${question} (y/n)`, fallback ? 'y' : 'n')).trim().toLowerCase()
  return answer === 'y' || answer === 'yes'
}

async function askNewPassword(prompter: Prompter): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const password = await prompter.secret(`Password (at least ${MIN_PASSWORD} characters)`)
    if (password.length < MIN_PASSWORD) continue
    if ((await prompter.secret('Repeat the password')) === password) return password
  }
  throw new KeithError('INTERNAL', 'no valid password entered')
}

/** `mind.name` from config.toml without resolving `env:` values (the key may not be set yet). */
async function mindName(configFile: string): Promise<string> {
  try {
    const raw: unknown = Bun.TOML.parse(await Bun.file(configFile).text())
    const mind = typeof raw === 'object' && raw !== null && 'mind' in raw ? raw.mind : undefined
    const name = typeof mind === 'object' && mind !== null && 'name' in mind ? mind.name : undefined
    if (typeof name === 'string' && name.trim() !== '') return name
  } catch {
    // An unreadable config is reported by `keith start`; the persona uses the default name.
  }
  return 'Keith'
}
