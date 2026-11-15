// The slash commands the web composer offers: the TUI's commands that make sense in a browser (the rest are keys or screens
// of the terminal). The words and the `/new`, `/compact` forms come from `@keith/app-model`.
import { completeCommand, matchCommands, parseContextCommand } from '@keith/app-model'

export interface WebCommand {
  /** What is typed, and what completes. */
  name: string
  /** One line in the menu. */
  hint: string
}

export const WEB_COMMANDS: readonly WebCommand[] = [
  { name: '/new', hint: 'start a new context (saves to memory first)' },
  { name: '/new --no-flush', hint: 'start a new context without saving' },
  { name: '/compact', hint: 'summarise the older part of this conversation' },
  { name: '/history', hint: 'earlier conversations, read only' },
  { name: '/tasks', hint: 'what runs in the background' },
  { name: '/manage', hint: 'manage Keith' },
  { name: '/whoami', hint: 'who you are signed in as' },
  { name: '/continue', hint: 'continue an interrupted turn' },
  { name: '/retry', hint: 'answer an interrupted turn again' },
  { name: '/help', hint: 'list the commands' },
]

const NAMES = WEB_COMMANDS.map((c) => c.name)

/** The commands that start with what is typed (a draft that starts with `/` and has no newline). */
export function suggestions(draft: string): WebCommand[] {
  const found = new Set(matchCommands(draft, NAMES))
  return WEB_COMMANDS.filter((c) => found.has(c.name))
}

/** What Tab or Enter on the menu gives: the one command that matches, else `undefined`. */
export const completion = (draft: string): string | undefined => completeCommand(draft, NAMES)

/** What a submitted line is. */
export type Submitted =
  | { kind: 'empty' }
  | { kind: 'message'; text: string }
  | { kind: 'new'; flush: boolean }
  | { kind: 'compact' }
  | { kind: 'usage'; text: string }
  | { kind: 'continue' }
  | { kind: 'retry' }
  | { kind: 'history' }
  | { kind: 'whoami' }
  | { kind: 'help' }
  | { kind: 'goto'; path: '/tasks' | '/manage' }
  | { kind: 'unknown'; text: string }

export function parseSubmitted(line: string): Submitted {
  const value = line.trim()
  if (value === '') return { kind: 'empty' }
  if (!value.startsWith('/')) return { kind: 'message', text: value }
  const [head = '', ...rest] = value.split(/\s+/)
  const name = head.toLowerCase()
  const args = rest.join(' ')
  switch (name) {
    case '/new':
    case '/compact': {
      const command = parseContextCommand(name === '/new' ? 'new' : 'compact', args)
      return command.kind === 'usage' ? { kind: 'usage', text: command.text } : command
    }
    case '/continue':
      return { kind: 'continue' }
    case '/retry':
      return { kind: 'retry' }
    case '/history':
      return { kind: 'history' }
    case '/whoami':
      return { kind: 'whoami' }
    case '/help':
      return { kind: 'help' }
    case '/tasks':
    case '/manage':
      return { kind: 'goto', path: name }
    default:
      return { kind: 'unknown', text: `Unknown command ${head}. /help lists the commands.` }
  }
}

/** The rows `/help` shows. */
export function helpRows(): string[] {
  return WEB_COMMANDS.map((c) => `${c.name} · ${c.hint}`)
}
