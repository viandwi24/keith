import { cells, FramePanel, ScrollView, Txt, useFooter } from '@keith/ui'
import { Box } from 'ink'

type Group = { title: string; rows: ReadonlyArray<[string, string]> }

export const HELP: ReadonlyArray<Group> = [
  {
    title: 'Commands',
    rows: [
      ['/manage', 'people, devices, nodes, providers, access, budget, audit'],
      ['/tasks', 'all tasks (enter opens one, s stops it)'],
      ['/nodes', 'paired nodes, read only'],
      ['/brain trace', 'the last 50 brain events'],
      ['/budget', 'cost this month, the limit and every person'],
      [
        '/mouse',
        'wheel scrolling on or off; off lets you select text (shift or alt + drag works with it on)',
      ],
      ['/history', 'your earlier chat contexts, newest first (read only; esc closes)'],
      ['/whoami', 'person, role, core and how you are connected'],
      ['/login', 'sign in to a core (password, device code or token)'],
      ['/logout', 'sign out of this core: revoke this device and forget its credential'],
      ['/stepup', 'confirm with your PIN before a sensitive action'],
      ['/continue', 'resume the interrupted turn'],
      ['/retry', 'redo the interrupted answer'],
      ['/help', 'this help'],
      ['/quit', 'quit'],
    ],
  },
  {
    title: 'Keys · Chat',
    rows: [
      ['enter', 'send the message'],
      ['shift+enter', 'new line (terminals with the Kitty keyboard protocol)'],
      ['alt+enter ctrl+j', 'new line anywhere (or a backslash, then enter)'],
      ['esc', 'stop the answer while it runs; when idle, go Home'],
      ['ctrl+g', 'go Home at any time; a running answer keeps going'],
      ['tab', 'give the keys to the approval dialog; complete a /command'],
      ['wheel alt+↑↓', 'scroll the conversation (3 lines a notch; one line)'],
      ['end', 'jump to the latest message'],
      ['ctrl+b', 'show or hide the sidebar'],
      ['ctrl+t', 'show or hide the tasks panel'],
      ['ctrl+o ctrl+p', 'a narrower or wider orb, if it looks stretched'],
    ],
  },
  {
    title: 'Keys · Home',
    rows: [
      ['enter', 'open the chat (when logged out: sign in)'],
      ['esc', 'while an answer runs: stop it'],
      ['tab', 'quick ask: type a line, enter sends it, the reply shows here; esc closes'],
      ['space', 'open or close the menu'],
      ['↑↓ or j k', 'move in the menu'],
      ['enter →', 'in the menu: show the details, open the full screen'],
      ['[ ]', 'a narrower or wider orb, if it looks stretched'],
    ],
  },
  {
    title: 'Keys · Tasks and other screens',
    rows: [
      ['↑↓', 'select a task'],
      ['enter', 'open a task'],
      ['s then y', 'stop the selected task (any other key cancels)'],
      ['wheel alt+↑↓', 'scroll a long list, end jumps to the bottom'],
      ['esc', 'back: the task list, then where you came from'],
    ],
  },
  {
    title: 'Keys · Manage',
    rows: [
      ['↑↓', 'select a section or a row'],
      ['enter', 'open the actions of the row'],
      ['tab', 'next section, or the next field of a form'],
      ['r', 'reload the section'],
      ['esc', 'close the dialog, then go back'],
    ],
  },
  {
    title: 'Keys · Dialogs',
    rows: [
      ['y n', 'allow or deny the approval (after tab)'],
      ['N', 'deny with a reason (enter sends, esc cancels)'],
      ['a', 'allow for the rest of the task'],
      ['enter tab esc', 'step-up: confirm, switch PIN or password, cancel'],
    ],
  },
  {
    title: 'On the core machine',
    rows: [
      ['keith-core model set front <id>', 'choose the front model'],
      ['keith-core provider add <id>', 'connect a provider'],
      ['keith-core pair', 'pair a node'],
      ['keith-core nodes revoke <name>', 'revoke a node'],
      ['keith-core budget set <usd|none>', 'the monthly limit'],
      ['keith-core devices approve <code>', 'approve a device login'],
    ],
  },
]

/** What a member sees instead of the owner's `keith-core` commands. */
const MEMBER_SETTINGS: Group = {
  title: 'Settings',
  rows: [
    ['Ask the owner', 'models, providers, nodes, budget and devices are set on the core machine'],
  ],
}

/** The help groups that apply to a role: a member's `/budget` is their own spend, settings are the owner's. */
export function helpFor(role: string | undefined): readonly Group[] {
  if (role === undefined || role === 'owner') return HELP
  return [
    ...HELP.slice(0, -1).map((g) =>
      g.title === 'Commands'
        ? {
            ...g,
            rows: g.rows.map(([k, t]): [string, string] =>
              k === '/budget' ? [k, 'your spend this month and your cap'] : [k, t],
            ),
          }
        : g,
    ),
    MEMBER_SETTINGS,
  ]
}

const FOOTER = [{ key: 'esc', action: 'back', priority: 80 }] as const

/** Columns the rows of a framed group get: the frame's two sides and one column of padding each. */
const ROW_CHROME = 4

function GroupRows({ group, width }: { group: Group; width: number }) {
  const room = width - ROW_CHROME
  const keyWidth = Math.max(...group.rows.map(([key]) => cells(key))) + 2
  // a key and its text side by side need room for both; otherwise the text goes under the key
  const stacked = keyWidth + 24 > room
  return (
    <FramePanel width={width} top={[{ text: group.title }]} padX={1}>
      {group.rows.map(([key, text]) =>
        stacked ? (
          <Box key={key} flexDirection="column">
            <Txt tone="accent" wrap="truncate-end">
              {key}
            </Txt>
            <Box paddingLeft={2}>
              <Txt tone="muted" wrap="truncate-end">
                {text}
              </Txt>
            </Box>
          </Box>
        ) : (
          <Box key={key}>
            <Box width={keyWidth} flexShrink={0}>
              <Txt tone="accent">{key}</Txt>
            </Box>
            <Txt wrap="truncate-end">{text}</Txt>
          </Box>
        ),
      )}
    </FramePanel>
  )
}

/**
 * `/help`: every command and key, in framed groups by screen (the hidden keys included), and the
 * `keith-core` commands that replaced the removed screens. Scrolls with the wheel and `alt+↑` `alt+↓`.
 */
export function HelpScreen({ width, role }: { width: number; role?: string | undefined }) {
  useFooter(FOOTER)
  return (
    <ScrollView anchor="top">
      {helpFor(role).map((group) => (
        <GroupRows key={group.title} group={group} width={width} />
      ))}
    </ScrollView>
  )
}
