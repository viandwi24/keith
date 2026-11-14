# CLI

Code: `packages/cli/src` (`prompts.ts`, `command.ts`, `help.ts`, `output.ts`, `keys.ts`, `io.ts`,
`errors.ts`). Tests: `prompts.test.ts`, `command.test.ts`. Plan: `docs/plans/done/P8-setup-and-identity.md`.

## Purpose

One toolkit for the three commands `keith-core`, `keith-node` and `keith`: prompts, a command
registry that renders `--help`, and calm output helpers. No third-party dependency (`node:util`
`parseArgs`, raw mode, plain ANSI). Apps use it through `@keith/cli`; `apps/tui` may import it too.

## Public API (`index.ts`)

| Export | Meaning |
| --- | --- |
| `CliIo` | `{ stdin, stdout, stderr?, isTTY?, env? }`. `processIo()` gives the real process streams. Every prompt and `runCli` take it, so tests use fake streams. |
| `isInteractive(io)` | `io.isTTY`, else stdin and stdout are both TTYs. |
| `ask(question, { default?, validate?, io? })` | Visible line. Shows `[default]`; Enter takes it; `validate` returns an error string to re-ask. |
| `askHidden(question, { validate?, io? })` | Raw mode, nothing echoed. Piped stdin: one line, no prompt text (`--api-key-stdin`). A secret is never trimmed: only the line ending (`\n`, `\r\n`) of piped input is removed. |
| `select(question, choices, { default?, io? })` | `choices: { value, label, hint? }[]`. Arrow keys and Enter in a terminal; a numbered list ("Type 1-N") otherwise. |
| `confirm(question, { default, io? })` | `y` or `n`; Enter takes the default. |
| `PromptCancelled` | Ctrl+C in any prompt. |
| `UsageError` | Wrong use (e.g. `missing --x`); exit 2. |
| `CliError(message, exitCode = 1)` | Runtime failure with a one-line message. |
| `defineCommand(def)` | `{ name, summary, usage?, flags?, positionals?, examples?, subcommands?, run? }`. A flag is `{ type: 'string' \| 'boolean', short?, multiple?, default?, description, placeholder? }`. |
| `CommandContext` | `values`, `positionals`, `io`, `program`, `path`, `string(name)`, `bool(name)`, `require(name)` (throws `UsageError("missing --name")`). |
| `runCli({ program, version, summary?, commands, defaultCommand?, argv, io })` | Routes, parses, runs; returns the exit code. |
| `printNextSteps(io, steps)`, `printTable(io, rows, { header? })`, `style(io, name, text)`, `colorEnabled(io)` | Output helpers; styles are `bold`, `dim`, `red`, `green`, `yellow`. |

## Behaviour

- **Routing.** `argv` has no program name. `--version`/`-V` prints `<program> <version>`. `--help`,
  `-h`, no arguments and `help [command]` print help (exit 0). Commands nest one level
  (`provider add`); a group without `run` prints its help. A subcommand may take positionals and read its action from them:
  `protocols settings get` is the `settings` subcommand of `protocols`, which reads `get` or `set` from its positionals. `defaultCommand` runs when argv is
  empty or starts with a flag (the TUI's chat).
  A group can mix commands that read the local database and commands that call the running core: core's `rooms list|show`
  and `persona show|history` read the database without the socket, `rooms end` and `persona template` call it (core-cli.md, "Commands").
- **Flags.** `parseArgs` in strict mode; positionals only when the command sets `positionals`.
  `-h`/`--help` exists on every command.
- **Help.** Sections `Usage`, `Commands` (summaries aligned), `Flags` (descriptions, `(default: x)`),
  `Examples`. Generated only from the definitions.
- **Typos.** `unknown command setpu. Did you mean setup?` (prefix match or edit distance <= 2);
  in a group the suggestion is the full path (`provider add`).
- **Exit codes.** 0 ok (or `run` returns a number), 1 runtime error (`<program>: <message>`, one
  line on stderr), 2 usage error (message plus `Try '<program> <path> --help'.`), 130 cancelled.
- **Prompts without a terminal.** Input is read line by line from stdin; several prompts share one
  pipe. End of input with no answer is a `UsageError` naming the question (exit 2), so a headless
  run fails naming what is missing.

## Invariants

- Hidden input is never written to stdout, in any mode.
- Server text is stripped: `stripControl(text, { newlines? })` removes C0 and C1 controls, ESC sequences (CSI, OSC, DCS), C1 CSI (U+009B, with its parameters), DEL and bidirectional overrides; `printTable` applies it to every cell and the `keith-core` commands apply it to every name or label they write. `packages/ui/src/safe-text.ts` is its twin.
- On Ctrl+C or a finished prompt the terminal is restored: raw mode off, cursor shown, listener
  removed, stdin paused. Ctrl+C rejects with `PromptCancelled`.
- Colour only when stdout is a TTY and `NO_COLOR` is unset or empty. Output has no emoji.
- No prompt reads `process` streams unless `io` is omitted.

## Rules

Rules for `packages/cli` and for code that uses it (the repo-wide rules are in `AGENTS.md`):

- **Command registry.** A command is a `defineCommand` definition; `runCli` routes and parses it.
- **Generated help.** `--help` and `help <command>` are generated only from the definitions (usage,
  flags, positionals, examples); the package has no hand-written help text.
- **Exit codes.** Only the codes listed under Behaviour: 0, 1 (`CliError`), 2 (`UsageError`), 130
  (`PromptCancelled`). `runCli` returns the code; the app decides when to exit.
- **Output helpers.** Output goes through `printTable`, `printNextSteps` and `style`. Server or
  model text goes through `stripControl` before it is written.
- **Environment.** The package reads no `KEITH_*` variable. It reads `NO_COLOR` only, from the
  injected `io.env` (default `process.env`, the one standard variable this package uses). Apps read
  their own configuration in `apps/*/src/platform/config.ts` (AGENTS.md rule 10), never here.
- **Injection.** Every prompt and `runCli` take an `io`; a package test never needs a real terminal.

## Tests

`prompts.test.ts`: default on Enter, validate re-ask, shared pipe, hidden input not echoed,
select by number and by arrow escape sequences, wrap-around, cancel restores the terminal,
confirm. `command.test.ts`: help output, `help <command>`, flag defaults, usage error exit 2,
typo suggestion (top level and nested), nested routing, runtime error exit 1, cancel exit 130,
default command, table and next-steps output, `NO_COLOR`.

`@keith/cli/testing` exports `fakeIo` (scripted stdin, captured stdout and stderr, TTY flag) for
the tests of apps that use the CLI.
