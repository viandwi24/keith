# apps/node

Peripheral node daemon: pairs with the core, keeps a heartbeat, runs motor commands. Spec: `docs/specs/node.md`.

- Binary `keith-node` (bin → `src/main.ts`, shebang kept): `setup` (interactive join, `--non-interactive`, `--force`),
  `join --core <url> --code <code> [--name] [--allow-shell] [--workdir]`, `run`, `status`; each takes `--config <path>`.
  Built on `@keith/cli`. `bun run start` = `bun src/main.ts`.
- Config `~/.keith/node.json` (or `KEITH_NODE_CONFIG`, or `$KEITH_HOME/node.json`; workdir `$KEITH_HOME/workspace`), dir 0700, file 0600; read only in `src/platform/config.ts`.
- Layout: `cli.ts` (runCli), `commands.ts`, `setup.ts`, `join-command.ts`, `join.ts`, `run.ts`, `connection.ts` (reconnect, injectable socket and clock), `manifest.ts`, `executor/`, `drivers.ts` (load, hash-check and start installed drivers), `driver-command.ts` (`driver` group).
- Drivers (spec `docs/specs/node-drivers.md`): `keith-node driver list` (installed drivers with state and options, plus the bundled ones that can be added), `driver add <name|folder> [--option key=value] [--allow-input] [--runtime docker|podman] [--network] [--image lang=ref] [--yes]` (shows what it can do and asks first; `--yes` installs without asking), `driver remove <name>`. Bundled: `desktop`, `sandbox` (`packages/driver-*`, built by `bun run build` in their folder). Changes apply after a restart of `keith-node run`. `--option backend=fake` selects the desktop driver's fake backend (no screen; the smoke test uses it).
- Tests never touch a real screen or a container runtime: desktop tests use the fake backend, sandbox tests a fake runtime host (`SandboxHost`), and `driver list`/`add` tests point `packagesRoot` at fixtures.
- Executor: `system.info`, `shell.exec` (`/bin/sh -c`, env PATH/HOME/LANG, cwd inside the workdir, own process group
  killed with `-pid`, timeout max 120 s, output capped at 30 000 characters).
- `shell.exec` always asks approval on the core; `allowShell` is off unless `join --allow-shell`.
- Protocol types come from `@keith/contracts` only.
- Tests: `bun test ./apps/node` from the repo root; they cover setup, join, run, connection, executor and the driver commands.
