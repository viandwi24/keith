/** The commands the `/` hint row offers (`/continue`, `/retry` and `/quit` included). */
export const SLASH_COMMANDS: readonly string[] = [
  '/new',
  '/compact',
  '/history',
  '/manage',
  '/tasks',
  '/inbox',
  '/room',
  '/persona',
  '/dream',
  '/dream now',
  '/dream apply',
  '/dream undo',
  '/dream mode off',
  '/dream mode propose',
  '/dream mode auto',
  '/nodes',
  '/brain trace',
  '/budget',
  '/succession',
  '/busy',
  '/free',
  '/presence',
  '/mouse',
  '/whoami',
  '/continue',
  '/retry',
  '/help',
  '/quit',
]

/** Commands that start with what is typed (a draft that starts with `/`); empty otherwise. */
export function matchCommands(
  draft: string,
  commands: readonly string[] = SLASH_COMMANDS,
): string[] {
  if (!draft.startsWith('/') || draft.includes('\n')) return []
  const typed = draft.toLowerCase()
  return commands.filter((c) => c.startsWith(typed))
}

/** The completion `tab` gives: the one command that matches, else `undefined`. */
export function completeCommand(
  draft: string,
  commands: readonly string[] = SLASH_COMMANDS,
): string | undefined {
  const found = matchCommands(draft, commands)
  return found.length === 1 && found[0] !== draft ? found[0] : undefined
}
