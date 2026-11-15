import { WEB_COMMANDS } from '../chat/slash.ts'

// The words of the Help page: keys, slash commands, what each screen does, and where the docs are. Plain data, so a test keeps it
// honest (every screen it names is in the nav, every command is one the composer offers).

export interface Shortcut {
  keys: string
  action: string
  where: string
}

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: '⌘K or Ctrl+K', action: 'Open or close the command palette', where: 'Anywhere' },
  {
    keys: '/',
    action: 'Open the slash command menu',
    where: 'Chat and quick ask, at the start of a message',
  },
  { keys: 'Tab or Enter', action: 'Complete the command the menu points at', where: 'Slash menu' },
  { keys: '↑ ↓', action: 'Move in the menu, the palette and the list of commands', where: 'Menus' },
  { keys: 'Enter', action: 'Send the message', where: 'Chat, quick ask and room composers' },
  { keys: 'Shift+Enter', action: 'New line', where: 'Chat and room composers' },
  {
    keys: 'Esc',
    action: 'Close the menu or the palette; in the chat, stop a running turn',
    where: 'Chat',
  },
  { keys: 'Tab', action: 'Move focus to an approval card', where: 'Chat and Inbox' },
  {
    keys: 'y  n  N  a',
    action: 'Allow once, deny, deny with a reason, allow for the task',
    where: 'An approval card that has focus',
  },
]

export interface HelpScreen {
  title: string
  /** Path under the app base. */
  path: string
  does: string
}

export const SCREENS: readonly HelpScreen[] = [
  {
    title: 'Home',
    path: '/',
    does: 'The orb, what Keith last said, a quick ask and a card for tasks, nodes, budget and approvals.',
  },
  {
    title: 'Chat',
    path: '/chat',
    does: 'Your conversation with Keith, its tool calls, questions and earlier conversations (History).',
  },
  {
    title: 'Tasks',
    path: '/tasks',
    does: 'What runs in the background: filter by status, open one for its result, stop a running one.',
  },
  {
    title: 'Rooms',
    path: '/rooms',
    does: 'Shared conversations with other people and Keith, and the invitations you have.',
  },
  {
    title: 'Inbox',
    path: '/inbox',
    does: 'Everything that waits for your answer, starting with approvals.',
  },
  {
    title: 'Nodes',
    path: '/nodes',
    does: 'Paired devices: online state, drivers, refused capabilities and whether a shell is allowed.',
  },
  {
    title: 'Budget',
    path: '/budget',
    does: "The month's spend against the limit, per person for the owner.",
  },
  {
    title: 'Presence',
    path: '/presence',
    does: 'Where Keith thinks you are, your clients, who may read your state, and a stated busy or out status.',
  },
  {
    title: 'Brain',
    path: '/brain',
    does: 'The eleven regions as they work and the trace of what the core just did.',
  },
  {
    title: 'Me',
    path: '/me',
    does: 'How Keith talks to you, the persona (owner), and Memory: dreaming, the diary and a staged plan.',
  },
  {
    title: 'Manage',
    path: '/manage',
    does: "People, access, providers, plugins and the rest of the owner's controls.",
  },
]

export interface HelpCommand {
  name: string
  hint: string
}

/** The commands the composer offers (the same list its menu uses). */
export const COMMANDS: readonly HelpCommand[] = WEB_COMMANDS.map((c) => ({
  name: c.name,
  hint: c.hint,
}))

/** Other terminal-only commands the TUI has; the web does these on a page instead. */
export const ON_A_PAGE: readonly { command: string; page: string; path: string }[] = [
  { command: '/nodes', page: 'Nodes', path: '/nodes' },
  { command: '/budget', page: 'Budget', path: '/budget' },
  { command: '/presence, /busy, /free', page: 'Presence', path: '/presence' },
  { command: '/brain', page: 'Brain', path: '/brain' },
  { command: '/room', page: 'Rooms', path: '/rooms' },
  { command: '/dream', page: 'Memory', path: '/me/memory' },
]

const REPO = 'https://github.com/viandwi24/keith/blob/main/docs'

export interface HelpLink {
  title: string
  href: string
  about: string
}

export const DOC_LINKS: readonly HelpLink[] = [
  { title: 'Guide', href: `${REPO}/guide.md`, about: 'How to use Keith day to day.' },
  {
    title: 'Architecture',
    href: `${REPO}/ARCHITECTURE.md`,
    about: 'The brain regions and how the parts fit.',
  },
  {
    title: 'Web client',
    href: `${REPO}/specs/web.md`,
    about: 'What this app does and how it is built.',
  },
  {
    title: 'Manual testing',
    href: `${REPO}/manual-testing.md`,
    about: 'How to try Keith by hand.',
  },
]
