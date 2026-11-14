#!/usr/bin/env bun
import { writeSync } from 'node:fs'
import { processIo, runCli } from '@keith/cli'
import { emitWheel, resolveTheme, ThemeProvider } from '@keith/ui'
import { render } from 'ink'
import pkg from '../package.json' with { type: 'json' }
import { AppRoot } from './app-root.tsx'
import { keithCommands } from './commands.tsx'
import type { Connection } from './connection.ts'
import { DEFAULT_CELL_ASPECT, detectCellAspect } from './platform/cell-size.ts'
import { loadConfig } from './platform/config.ts'
import { createMouse, filterInput, kittyKeys } from './platform/terminal-input.ts'

const { clientConfigPath, dataDir, theme, depth, cellAspect } = loadConfig()
const controller = new AbortController()

/** Draw the app full screen on a connection; returns when the user quits. */
async function open(
  connection: Connection,
  start: 'home' | 'chat' | 'manage' | 'login',
): Promise<number> {
  // the terminal's own cell size, asked before Ink reads stdin; KEITH_CELL_ASPECT overrides it
  const aspect =
    cellAspect ?? (depth === 'none' ? undefined : await detectCellAspect()) ?? DEFAULT_CELL_ASPECT
  // the wheel and the Kitty keyboard reply are read in front of Ink (it has no mouse API); the
  // terminal is handed back out of mouse mode on every way out (exit, error, signals)
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true
  const mouse = createMouse(
    (text) => {
      try {
        writeSync(1, text)
      } catch {
        // the terminal is gone: nothing to restore
      }
    },
    { hookProcess: true },
  )
  const unfilter = filterInput(process.stdin, {
    onWheel: emitWheel,
    onKitty: () => kittyKeys.set(true),
  })
  if (interactive) mouse.set(true)
  // raw before Ink's first write: its Kitty query is answered at once, and with the tty still in
  // line mode the reply would be echoed on screen as `^[[?0u`
  if (interactive) process.stdin.setRawMode?.(true)
  const app = render(
    <ThemeProvider theme={resolveTheme({ theme, depth })} spinner={depth !== 'none'}>
      <AppRoot
        connection={connection}
        start={start}
        cellAspect={aspect}
        mouse={interactive ? mouse : undefined}
        configPath={clientConfigPath}
      />
    </ThemeProvider>,
    // full screen: the app owns its scrolling and restores the terminal on exit
    {
      alternateScreen: true,
      incrementalRendering: true,
      // `shift+enter` is a newline where the terminal reports it (kitty, WezTerm, Ghostty, ...)
      kittyKeyboard: { mode: 'auto', flags: ['disambiguateEscapeCodes'] },
    },
  )
  try {
    await app.waitUntilExit()
  } finally {
    if (interactive) process.stdin.setRawMode?.(false)
    mouse.dispose()
    unfilter()
  }
  return 0
}

process.once('SIGTERM', () => controller.abort())

process.exit(
  await runCli({
    program: 'keith',
    version: pkg.version,
    summary:
      'Chat with Keith, your personal agent. Settings live on the core machine (keith-core).',
    defaultCommand: 'home',
    argv: process.argv.slice(2),
    io: processIo(),
    commands: keithCommands({
      configPath: clientConfigPath,
      dataDir,
      signal: controller.signal,
      startChat: (connection) => open(connection, 'chat'),
      startHome: (connection) => open(connection, 'home'),
      startManage: (connection) => open(connection, 'manage'),
      startLogin: (connection) => open(connection, 'login'),
    }),
  }),
)
