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

/** A plugin `keith setup` offers besides the provider. Enabled, not required: Keith starts without it. */
export type OptionalPlugin = {
  key: 'web' | 'weather'
  /** Plugin package (= plugin id). */
  pluginId: string
  question: string
  /** Default answer. */
  enable: boolean
  /** Config lines of its `[plugins."<id>"]` section, written commented out as a hint. */
  hints: string[]
}

export const OPTIONAL_PLUGINS: readonly OptionalPlugin[] = [
  {
    key: 'web',
    pluginId: '@keith/web',
    question: 'Enable the web app (@keith/web, served at the core URL)?',
    enable: true,
    hints: ['# distDir = "/path/to/plugins/web/dist"   # default: the package\'s own dist/'],
  },
  {
    key: 'weather',
    pluginId: '@keith/tool-weather',
    question: 'Enable the weather tool (@keith/tool-weather, uses Open-Meteo)?',
    enable: true,
    hints: ['# homeCity = "Surabaya"   # rain alerts when you arrive', '# units = "metric"'],
  },
]

/** A voice plugin `keith setup` can enable, with its `[plugins."<id>"]` lines. */
export type VoicePlugin = { pluginId: string; lines: string[] }

const VAD_ENERGY: VoicePlugin = {
  pluginId: '@keith/vad-energy',
  lines: [
    '# startDb = 12        # dB above the noise floor that starts speech',
    '# hangoverMs = 500    # silence that ends it',
  ],
}
const VOICE_GROQ: VoicePlugin = {
  pluginId: '@keith/voice-groq',
  lines: ['apiKey = "env:GROQ_API_KEY"', '# model = "whisper-large-v3-turbo"'],
}
const VOICE_OPENAI: VoicePlugin = {
  pluginId: '@keith/voice-openai',
  lines: ['apiKey = "env:OPENAI_API_KEY"', '# model = "gpt-4o-mini-tts"', '# voice = "alloy"'],
}
const VOICE_SPEACHES: VoicePlugin = {
  pluginId: '@keith/voice-speaches',
  lines: [
    '# baseUrl = "http://127.0.0.1:8000/v1"',
    '# sttModel = "Systran/faster-whisper-small"',
    '# ttsModel = "speaches-ai/Kokoro-82M-v1.0-ONNX"',
    '# voice = "af_heart"',
  ],
}

/** The speaches container (https://speaches.ai/installation/, CPU image). */
export const SPEACHES_DOCKER_RUN =
  'docker run --rm --detach --publish 8000:8000 --name speaches --volume hf-hub-cache:/home/ubuntu/.cache/huggingface/hub ghcr.io/speaches-ai/speaches:latest-cpu'

/** The voice answers of `keith setup` (docs/architecture/voice.md, ADR-0013). */
export type VoiceChoice = {
  key: 'none' | 'cloud' | 'local' | 'mixed'
  label: string
  /** `[voice]` provider ids; null for `none`. */
  providers: { vad: string; stt: string; tts: string } | null
  plugins: readonly VoicePlugin[]
  /** Env vars the person must export. */
  envVars: readonly string[]
  /** Needs a local speaches server. */
  speaches: boolean
}

export const VOICE_CHOICES: readonly VoiceChoice[] = [
  { key: 'none', label: 'none', providers: null, plugins: [], envVars: [], speaches: false },
  {
    key: 'cloud',
    label: 'cloud (Groq STT + OpenAI TTS)',
    providers: { vad: 'energy', stt: 'groq', tts: 'openai' },
    plugins: [VAD_ENERGY, VOICE_GROQ, VOICE_OPENAI],
    envVars: ['GROQ_API_KEY', 'OPENAI_API_KEY'],
    speaches: false,
  },
  {
    key: 'local',
    label: 'local (speaches)',
    providers: { vad: 'energy', stt: 'speaches', tts: 'speaches' },
    plugins: [VAD_ENERGY, VOICE_SPEACHES],
    envVars: [],
    speaches: true,
  },
  {
    key: 'mixed',
    label: 'mixed (Groq STT + local speaches TTS)',
    providers: { vad: 'energy', stt: 'groq', tts: 'speaches' },
    plugins: [VAD_ENERGY, VOICE_GROQ, VOICE_SPEACHES],
    envVars: ['GROQ_API_KEY'],
    speaches: true,
  },
]

/**
 * The config.toml `keith setup` writes: the chosen provider (enabled and required), every role on
 * one model, plus the optional plugins the person enabled.
 */
export function renderConfig(
  choice: ProviderChoice,
  model: string,
  optional: readonly OptionalPlugin[] = [],
  voice: VoiceChoice = VOICE_CHOICES[0] as VoiceChoice,
): string {
  const ref = JSON.stringify(`${choice.providerId}:${model}`)
  const plugin = JSON.stringify(choice.pluginId)
  const enabled = [plugin, ...[...optional, ...voice.plugins].map((p) => JSON.stringify(p.pluginId))]
  const voiceSection = voice.providers
    ? [
        '[voice]                            # docs/architecture/voice.md',
        `vad = ${JSON.stringify(voice.providers.vad)}`,
        `stt = ${JSON.stringify(voice.providers.stt)}`,
        `tts = ${JSON.stringify(voice.providers.tts)}`,
        '# language = "en"                  # hint for STT and TTS; omitted = detected',
        '',
      ]
    : []
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
    `enabled  = [${enabled.join(', ')}]`,
    `required = [${plugin}]`,
    '',
    `[plugins.${plugin}]`,
    `apiKey = ${JSON.stringify(`env:${choice.envVar}`)}`,
    ...choice.extra,
    '',
    ...optional.flatMap((p) => [`[plugins.${JSON.stringify(p.pluginId)}]`, ...p.hints, '']),
    ...voice.plugins.flatMap((p) => [`[plugins.${JSON.stringify(p.pluginId)}]`, ...p.lines, '']),
    ...voiceSection,
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
  const optional: OptionalPlugin[] = []
  let voice: VoiceChoice = VOICE_CHOICES[0] as VoiceChoice
  if (await configFile.exists()) {
    out(`Keeping the existing ${paths.configFile}`)
    const existing = await readRawConfig(paths.configFile)
    for (const p of missingOptionalPlugins(existing)) {
      out(`To enable ${p.pluginId}, add "${p.pluginId}" to plugins.enabled in config.toml.`)
    }
    if (existing !== null && !('voice' in existing)) {
      out('To turn voice on, add a [voice] section and enable its plugins (docs/architecture/voice.md).')
    }
  } else {
    choice = await askProvider(prompter)
    const model = await askNonEmpty(
      prompter,
      `Model id for ${choice.label} (the default may be outdated; check ${choice.label}'s model list)`,
      choice.defaultModel,
    )
    for (const p of OPTIONAL_PLUGINS) {
      if (await askYesNo(prompter, p.question, p.enable)) optional.push(p)
    }
    voice = await askVoice(prompter)
    await Bun.write(paths.configFile, renderConfig(choice, model, optional, voice))
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
      if (optional.some((p) => p.key === 'web')) {
        out("Web app: build it once with 'bun run --cwd plugins/web build', then open http://127.0.0.1:4824/")
      }
      if (voice.envVars.length > 0) {
        out(`Voice: export ${voice.envVars.map((v) => `${v}=<your key>`).join(' and ')}.`)
      }
      if (voice.speaches) {
        out(`Voice: start a local speaches server first (http://127.0.0.1:8000/v1):`)
        out(`  ${SPEACHES_DOCKER_RUN}`)
      }
      if (voice.providers)
        out('Voice needs the web app (mic and speaker) and a secure context: localhost or HTTPS.')
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

async function askVoice(prompter: Prompter): Promise<VoiceChoice> {
  const options = VOICE_CHOICES.map((c, i) => `${i + 1}) ${c.label}`).join('  ')
  for (;;) {
    const answer = (await prompter.ask(`Voice: ${options}`, '1')).trim().toLowerCase()
    const found = VOICE_CHOICES[Number(answer) - 1] ?? VOICE_CHOICES.find((c) => c.key === answer)
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

/** An existing config.toml as a raw table, without resolving `env:` values (unreadable: null). */
async function readRawConfig(configFile: string): Promise<object | null> {
  try {
    const raw: unknown = Bun.TOML.parse(await Bun.file(configFile).text())
    return typeof raw === 'object' && raw !== null ? raw : null
  } catch {
    return null
  }
}

/** The optional plugins an existing config.toml does not enable (unreadable config: none). */
function missingOptionalPlugins(raw: object | null): OptionalPlugin[] {
  if (raw === null) return []
  const plugins = 'plugins' in raw ? raw.plugins : undefined
  const enabled =
    typeof plugins === 'object' && plugins !== null && 'enabled' in plugins ? plugins.enabled : undefined
  const list = Array.isArray(enabled) ? enabled : []
  return OPTIONAL_PLUGINS.filter((p) => !list.includes(p.pluginId))
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
