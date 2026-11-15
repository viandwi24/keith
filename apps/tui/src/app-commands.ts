import type { Health, ModelRoles, PresenceStatusSet, PresenceStatusView } from '@keith/contracts'
import { shorten } from './app-hints.ts'
import type { ChatNotice } from './features/chat/index.ts'
import { type Identity, whoamiRows } from './features/identity/index.ts'
import { type BusyParse, parseBusy, statusReply } from './features/presence/index.ts'
import type { StepUp } from './features/stepup/index.ts'
import { ASK_OWNER, BUDGET_MOVED, MOVED } from './messages.ts'

/** What a slash command may touch. */
export interface CommandEnv {
  exit(): void
  /** Open a screen (Esc comes back to where this was typed). */
  go(
    screen:
      | 'help'
      | 'tasks'
      | 'trace'
      | 'nodes'
      | 'budget'
      | 'presence'
      | 'manage'
      | 'history'
      | 'inbox',
  ): void
  /** `/login` and `/logout` open the Sign in and Sign out screens (Esc comes back). */
  openLogin(): void
  openLogout(): void
  /** `/manage` opens on the first section. */
  resetManage(): void
  /** `/succession`: the heir's panel over Home (the owner is pointed to Manage there). */
  openSuccession(): void
  toggleBrain(): void
  say(level: ChatNotice['level'], rows: readonly string[]): void
  clearNotice(): void
  isMember: boolean
  identity: Identity
  core: string
  health: Health | undefined
  roles: ModelRoles | undefined
  stepUp: StepUp
  /** The core cannot be reached (the offline mode's reason): commands that need it are refused. */
  offline?: string | undefined
  /** Wheel reporting (`/mouse`); absent without a terminal. */
  mouse?: { enabled(): boolean; set(on: boolean): void } | undefined
  /** `/room …`: the arguments after the word (the room features run them). */
  room(args: string): void
  /** `/persona …`: the arguments after the word (the persona feature runs them). */
  persona(args: string): void
  /** `/new` and `/compact`: the name and the arguments after it (the chat context feature runs them). */
  context(name: 'new' | 'compact', args: string): void
  /** `/dream …`: the arguments after the word (the memory feature runs them). */
  dream(args: string): void
  /** Busy or free for the person (`/busy`, `/free`): `presence.setStatus`. */
  setStatus?: ((input: PresenceStatusSet) => Promise<PresenceStatusView>) | undefined
}

/** The commands that read or change something on the core; offline they are refused (`/help`, `/quit`, `/logout`, `/login`, `/brain`, `/mouse` and `/whoami` stay). */
const NEEDS_CORE = new Set([
  'manage',
  'tasks',
  'inbox',
  'room',
  'persona',
  'dream',
  'new',
  'compact',
  'history',
  'nodes',
  'budget',
  'succession',
  'stepup',
  'presence',
  'busy',
  'free',
])

/** Runs a `/command` typed in the chat; the app's notice carries the answer. */
export function runCommand(line: string, env: CommandEnv): void {
  const { say, identity, stepUp } = env
  const [name, arg] = line.slice(1).split(/\s+/)
  env.clearNotice()
  if (env.offline !== undefined && name !== undefined && NEEDS_CORE.has(name)) {
    say('info', [`offline: ${env.offline} · [r] retry now`])
    return
  }
  const moved = name === undefined ? undefined : MOVED[name]
  if (name === 'quit' || name === 'exit') {
    env.exit()
  } else if (name === 'brain') {
    if (arg === 'trace') env.go('trace')
    else env.toggleBrain()
  } else if (moved !== undefined) {
    say('info', env.isMember ? ASK_OWNER : moved)
  } else if (name === 'budget' && arg !== undefined) {
    say('info', env.isMember ? ASK_OWNER : BUDGET_MOVED)
  } else if (name === 'whoami') {
    if (identity.status === 'logged-out') say('info', ['Logged out. Press enter to sign in.'])
    else if (identity.status !== 'ready') say('info', ['No identity yet.'])
    else
      say(
        'info',
        whoamiRows({
          me: identity.me,
          core: shorten(env.core),
          health: env.health,
          roles: env.roles,
          elevatedUntil: stepUp.elevatedUntil,
        }),
      )
  } else if (name === 'succession') {
    env.openSuccession()
  } else if (name === 'login') {
    env.openLogin()
  } else if (name === 'logout') {
    env.openLogout()
  } else if (name === 'stepup') {
    if (identity.status === 'ready' && identity.me.via === 'local')
      say('info', ['This connection is always confirmed (local socket).'])
    else
      stepUp.elevate().then(
        () => say('info', ['Confirmed. Sensitive actions are open for 10 minutes.']),
        () => say('info', ['Not confirmed.']),
      )
  } else if (name === 'mouse') {
    say('info', mouseReply(arg, env.mouse))
  } else if (name === 'manage') {
    env.resetManage()
    env.go('manage')
  } else if (
    name === 'help' ||
    name === 'tasks' ||
    name === 'nodes' ||
    name === 'budget' ||
    name === 'inbox'
  ) {
    env.go(name)
  } else if (name === 'room') {
    env.room(line.slice(1 + name.length).trim())
  } else if (name === 'persona') {
    env.persona(line.slice(1 + name.length).trim())
  } else if (name === 'dream') {
    env.dream(line.slice(1 + name.length).trim())
  } else if (name === 'new' || name === 'compact') {
    env.context(name, line.slice(1 + name.length).trim())
  } else if (name === 'history') {
    env.go('history')
  } else if (name === 'presence') {
    env.go('presence')
  } else if (name === 'busy' || name === 'free') {
    setBusy(name, line, env)
  } else {
    say('warning', [`Unknown command: ${line}. Type /help.`])
  }
}

/** `/busy [30m|2h] [note]` and `/free`: the person's manual status, through `presence.setStatus`. */
function setBusy(name: 'busy' | 'free', line: string, env: CommandEnv): void {
  const parsed: BusyParse =
    name === 'free' ? { ok: true, value: { busy: false } } : parseBusy(line.slice(1 + name.length))
  if (!parsed.ok) env.say('warning', [parsed.reason])
  else if (env.setStatus === undefined) env.say('info', ['Presence needs the core.'])
  else
    env.setStatus(parsed.value).then(
      (view) => env.say('info', [statusReply(view)]),
      (error: Error) => env.say('warning', [`Could not change your status: ${error.message}`]),
    )
}

/** `/mouse on|off` (no argument toggles): wheel scrolling against native text selection, for the session. */
export function mouseReply(arg: string | undefined, mouse: CommandEnv['mouse']): string[] {
  if (mouse === undefined) return ['Mouse scrolling needs a terminal.']
  if (arg !== undefined && arg !== 'on' && arg !== 'off') return ['Usage: /mouse on | /mouse off']
  const on = arg === undefined ? !mouse.enabled() : arg === 'on'
  mouse.set(on)
  return on
    ? ['Mouse on: the wheel scrolls. Hold shift (alt in some terminals) and drag to select text.']
    : ['Mouse off: select and copy text as usual; /mouse on brings the wheel back.']
}
