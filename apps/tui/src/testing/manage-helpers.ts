import { frameUntil, pressUntil } from './ink.ts'

export const DOWN = '\u001b[B'
export const UP = '\u001b[A'
export const RIGHT = '\u001b[C'
export const ESC = '\u001b'

/** The sections of the list in the order the owner sees them. */
export const ORDER = [
  'Overview',
  'People',
  'Groups',
  'Plugins',
  'Reviews',
  'Protocols',
  'Devices & tokens',
  'Nodes',
  'Providers & models',
  'Persona',
  'Access',
  'Succession',
  'Budget',
  'Logs',
  'Privacy',
  'Audit',
] as const

interface App {
  stdin: { write(data: string): void }
  lastFrame(): string | undefined
}

/** Type text into the focused field, one character per write. */
export async function type(app: App, text: string): Promise<void> {
  for (const ch of text) {
    app.stdin.write(ch)
    await Bun.sleep(3)
  }
}

/** Move the section list to `title` (from the top) and hand the keys to the rows. */
export async function openSection(
  app: App,
  title: string,
  order: readonly string[] = ORDER,
): Promise<string> {
  const at = order.indexOf(title)
  if (at === -1) throw new Error(`no section ${title}`)
  for (let i = 1; i <= at; i++) {
    const next = order[i] ?? ''
    await pressUntil(app.stdin, app.lastFrame, DOWN, (f) => f.includes(`▸ ${next}`))
  }
  await pressUntil(app.stdin, app.lastFrame, '\r', (f) => f.includes('[enter] actions'))
  return frameUntil(app.lastFrame, (f) => f.includes('[enter] actions') && !f.includes('loading…'))
}

/** Select the row whose first cell starts with `text` with the arrow keys. */
export async function selectRow(app: App, text: string, max = 24): Promise<void> {
  // down first; when the row is above the selection (the list ends), up
  for (let i = 0; i < max * 2; i++) {
    const frame = app.lastFrame() ?? ''
    if (frame.split('\n').some((l) => l.includes(`▸ ${text}`))) return
    app.stdin.write(i < max ? DOWN : UP)
    await Bun.sleep(40)
  }
  throw new Error(`row ${text} never got selected:\n${app.lastFrame()}`)
}

/** Open the action menu of the selected row and run the action called `label`. */
export async function runAction(app: App, label: string): Promise<void> {
  await pressUntil(app.stdin, app.lastFrame, '\r', (f) => f.includes('Actions'))
  await Bun.sleep(80) // Ink attaches the menu's keys in an effect
  await selectRow(app, label)
  app.stdin.write('\r')
}
