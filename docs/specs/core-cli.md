# keith-core CLI

Code: `apps/core/src/cli.ts` (bin entry, `#!/usr/bin/env bun`), `apps/core/src/cli/` (`program.ts`,
`setup.ts`, `setup-steps.ts`, `setup-apply.ts`, `setup-wizard*.tsx`, `console*.tsx`, `ink-run.tsx`,
`start.ts`, `status.ts`, `doctor.ts` (the table of checks; one file per check in `doctor/checks/`), `admin-commands.ts`, `ops-commands.ts`, `context.ts`),
`apps/core/src/run-core.ts`, `apps/core/src/modules/admin/` (offline layer, lock,
effective network, `admin.*` procedures), `apps/core/src/modules/local-socket/`.
Built on `@keith/cli` (`cli.md`). Plan: `docs/plans/done/P8-setup-and-identity.md` (sections 1 to 3).

## Purpose

Set Keith up and administer it from the machine that runs core. Two channels:

- **Offline**: with core stopped, in process, through the same services core uses, under
  `<dataDir>/core.lock`. Commands: `setup`, `db migrate`, `token recover`. They refuse while the
  socket answers (`core is running; stop it before ...`, exit 1).
- **Online**: with core running, through the owner-only Unix socket and the typed client
  (`@keith/client` with `fetch(url, { unix })` and no token). Commands: everything else that changes
  or reads running state. They refuse while the socket does not answer
  (`core is not running; start it with keith-core start`, exit 1).

`start`, `doctor`, `config show` and `status` work in either state (see each).

## Console (no arguments)

`keith-core` with no arguments, on a terminal (stdin and stdout are TTYs), opens the console. With
`--help`, or without a terminal, it prints the help as before. The console is a full-screen Ink view
drawn with `@keith/ui` (theme and colour options come from `KEITH_THEME`, `NO_COLOR`, `COLORTERM`,
`TERM` and `COLORFGBG`, read in `platform/config.ts`). It looks at the data folder and picks one of:

- **Core running** (the owner socket answers): it runs `keith manage --core unix:<socketPath>` with
  inherited stdio and exits with its code. `keith` is found with `Bun.which`; when it is not on PATH
  the console prints the command and says to run `bun run link` once from a checkout.
- **Not set up**: the setup wizard (below); after a save, the home screen.
- **Set up, core stopped**: the home screen with *Start core* (leaves Ink, makes the same owner sign-in offer as `start`, then runs `start` in this
  process), *Doctor* (the same checks as `doctor`, shown on the screen), *Run setup again* (the
  wizard) and *Quit*. Keys: arrows and enter, or `s`, `d`, `r`, `q`; `esc` quits.

Management of a running core (people, devices, nodes, providers, budget, audit) is `keith manage`
(`tui.md`); this console only hands over to it. ADR-0010.

## Commands

| Command | Channel | What it does |
| --- | --- | --- |
| `setup` | offline | Name, provider, models, budget, access. On a terminal with no answer flag it opens the full-screen wizard (below); otherwise line prompts or flags. Re-runnable (current values are the defaults). Setup that sets the owner's secret (PIN or password) ends the owner's other sessions, and every setup change is audited with `via: offline` (ADR-0027 §5, §7). A removed budget limit (null) is kept by a headless re-run without `--budget`, and a re-run renames the current owner, not the id `owner` (ADR-0027 §24). |
| `start` | - | Run core. Unconfigured data dir: TTY offers `setup` first, no TTY exits 2 (`run keith-core setup`). `--no-setup-check` skips that. A set-up folder whose owner has no PIN and no password: a terminal offers to set a PIN now (asked twice), no terminal prints `the owner has no way to sign in ...` on stderr and still starts (the first `keith` start then offers the first-owner flow, `auth.md`). Creates a new database, or snapshots a behind one to `<dataDir>/backups/` (`VACUUM INTO`, `db.md`) and then migrates it, under `core.lock`; the block is logged (ADR-0027 §3). Refuses a database a newer build wrote or one that cannot be read, with the reason. Prints no token. |
| `status` | socket | `core up/down`, URLs (tcp, socket, public), access, front and cortex model, budget spent/limit, nodes online/total. Exit 1 when down. |
| `doctor [--offline]` | either | One line per check, `✓`, `!` or `✗`, then ` name — hint`. Exit 1 if any `✗`. A role model (front, cortex, guest) with no catalog price is a `!` line (`price <ref>`; skipped with `--offline`; ADR-0027 §23). The `database` line names the state (`db.md`, States): `✓` when migrated; `✗` for missing or behind (run `db migrate`); `✗` for ahead, diverged or unreadable, with the refusal text as the hint. A stored provider key this process cannot open (lost or changed `KEITH_SECRET_KEY`, OWN-012) is a `!` note, `provider <id>`, hint `doctor cannot read the key the core uses: run it with the same KEITH_SECRET_KEY`, never a `✗` (P23.4.6); `start`, `setup`, `token recover` and `auth * reset` still open, warn and write `settings.unreadable` to the audit log. **Doctor is read only** (P23.4.6): it opens the database read only (no migration, no WAL switch, no folder change), takes no lock, creates no `secret.key` (no key in its environment means the stored keys read as unreadable), writes no audit row and never seeds the budget, so a run leaves the folder and the live log as they were. Fails `owner sign-in` (`✗`, exit 1) when the owner has neither a PIN nor a password: nobody could sign in on this machine; the hint names the command (`keith-core setup`, or open `keith`: it offers the first-owner flow), and when the owner has a PIN or a password but `can_login` is off (FD13-08: every remote sign-in is refused; the hint names `people transfer-owner <username>`). With a running core it adds `plugin views`: the terminal views open now as `<view> for <person id> (<age> s)`, asked over the socket (`admin.plugins.views.list`); a locked socket, a refusal or a socket that needs an admin session is a `!` note, never a `✗`. Doctor never prompts (P23.4.5): it asks the socket without the owner PIN, so a missing session reads `needs an admin session, run keith-core login` and piped or cron input is never taken as the PIN. The `delivery` line is a `!` note when `pending` deliveries are older than an hour (the count; the core retries them on its tick), and names the `failed` deliveries of the last 7 days in the hint (source, recipient, reason, never the text; `delivery.md`). The `protocols` line is `✓` with the count of enabled protocols and both built-ins on; it is a `!` note when a built-in (`approval-stale`, `reminder-missed`) is missing or switched off (`hypothalamus.md`, "Built-ins"). With a running core it adds one line per node (`node <name>`, `cli/doctor/checks/drivers.ts`), asked over the socket (`nodes.list`, the rows the TUI shows): `<driver> <version> · <capabilities without the prefix>` for each driver, joined with `; `, and `refused <id> (<reason>)` for each refused capability; a refusal is a `!` line, a node with no driver says `no drivers announced`, and a locked socket or one that needs an admin session is a `!` note. The `backup` line is a `!` note when `<data>/backups/` holds no archive or snapshot younger than 30 days (`backup.md`), never a `✗`. |
| `access [local\|remote] [--public-url u] [--bind h] [--proxy none\|tailscale-serve]` | socket | Show or set access. Says `restart needed` when the bind address changed. `--proxy` alone keeps the mode; it stores `access.proxy` (used by P9). |
| `provider add <id>\|list\|remove <id>\|test <id>` | socket | Connections. `add` reads the key hidden or from stdin (`--api-key-stdin`), saves, tests. |
| `model list\|set <front\|cortex\|guest> <id>` | socket | Role picks and the models of each connection. `<id>` may be `connection:model`. |
| `model price set <connection:model> --in <usd> --out <usd>` / `model price clear <connection:model>` | socket | A manual price per model, USD per million tokens (step-up; ADR-0027 §23). Its spend is counted and guests may use it. |
| `budget show\|set <usd\|none>` | socket | Monthly limit. An amount is a plain decimal of USD from 0 to 10000 with at most two places, or `none` (`parseUsdLimit`, the one parser of CLI, setup and TUI); an empty or other text is exit 2 and the limit does not move (FD10-04). |
| `pair` | socket | Pairing code and the `keith-node join` command (with the public URL, or localhost). |
| `nodes list\|revoke <name>` | socket | Paired nodes. |
| `nodes sandbox-limit [<n>]` | socket | The calls per hour one person may make to the sandbox without an approval (`nodes.sandbox.maxPerHourPerPerson`, node-drivers.md "Settings"): no argument prints the value (default 60, 1 to 1000); a whole number sets it (`nodes.settings.set`, owner; audited as `settings.nodes.set`). A value out of bounds is a usage error and nothing is written. |
| `config show` | local read | Each effective value with its source (`env`, `db`, `default`). |
| `people login <username> on\|off` | socket | Owner only (`people.md`, Identifiers and `can_login`): turns a member's sign-in on or off. Off ends their sessions and keeps their credentials; the owner and the owner's own account are refused. Audited `person.login.set`. |
| `people export <username> [--out <file>] \| --removed <personId> [--out <file>]` | socket | Owner only (`people.md`, Export): writes `exports/<username>-<timestamp>.tar` (0600) with the person's memory, workspace and conversation, and prints it; `--out` also copies it to a file (0600). `--removed` exports a removed person while their data is kept (the id `people remove` printed). Audited `person.exported`. A delegate is refused. |
| `people list\|add <username> [--name t] [--role member]\|rename <username> [<new>] [--name t]\|role <username> <role>\|suspend\|reactivate\|remove <username>\|transfer-owner <username>\|passwd <username> [--password-stdin]\|pin <username> [--pin-stdin]\|unlock <username>\|clear-password <username>\|clear-pin <username>\|grant <username> [<capability>]\|revoke-grant <username> <capability>` | socket | People (`people.md`). `list` prints username, name, role, status, added and id; the others one line. `remove` asks `remove <username> and keep their data for 30 days? [y/N]` and `transfer-owner` asks to type the new owner's username (`--yes` skips the question; without a terminal and without `--yes` both exit 2). `remove` keeps the person's memory, workspace and conversations in `workspace/keith/removed/<id>` until the date it prints (30 days, then purged; `people.md`, Rules), deletes the person and their credentials (the audit log stays) and refuses the owner; `role` and `suspend` refuse the owner; `transfer-owner` is atomic and revokes both people's sessions; it refuses a target whose sign-in is off (FD13-02: the new owner must be able to sign in, so the message names `people login <username> on`, which is run first). `passwd` and `pin` ask twice with hidden input in a terminal, or read one line with `--password-stdin` / `--pin-stdin`; without a terminal and without the flag they refuse (a secret never comes from argv); they apply the rules of `auth.md` and print what was refused; a new password signs the person out everywhere. `unlock` clears a member's lock and failure counters (`was not locked` otherwise); `clear-password` revokes sessions. `grant` adds one capability of the closed set (`permissions.md`) on top of the person's role and prints their grants (without a capability it only lists them); `revoke-grant` takes one back; both are idempotent and audited. Usernames are lowercased by the CLI. |
| `sessions list [<username>]\|revoke <id>` | socket | Live sign-in sessions (`auth.md`, Sessions): id, methods, label, created, last seen, address and when it ends; `revoke` ends one at once. |
| `auth policy show\|set --file <f>\|reset` | socket; `reset` offline | The sign-in policy (`auth.md`, Stored policy). `show` prints the stored policy or the built-in default; `set` stores a JSON policy (owner, audited, lockout guard); `reset` removes the stored policy with the core stopped. |
| `login`, `logout` | socket | Keep an admin session in this shell only: `eval "$(keith-core login)"` (`auth.md`, "The admin session") |
| `auth local show\|set [--trust none\|idle-lock\|full] [--idle-minutes <n>] [--person <u>] [--yes]\|reset` | socket; `set` and `reset` also offline | The local socket's access (default trust `none`) (`auth.md`, The local socket). `show` prints the trust level and whether the idle-lock is on; `set` changes the trust level (`full` prints a warning and needs `--yes` or a typed confirmation; `none` prints what changes) and/or the idle minutes (`0` = never); `reset` removes the stored settings (trust back to `none`) with the core stopped; `set` with the core stopped writes the owner's level directly (audited `via: offline`). Owner, audited. |
| `devices list\|approve <code> [--label t]\|deny <code>\|revoke <id>` | socket | Device login (`auth.md`). `list` shows waiting requests (label, address, age) and device credentials; `approve` accepts the code in any case, with or without the dash. |
| `token create --label t\|list\|revoke <id>` | socket | `token` credentials (`keith_s_…`, for scripts). `create` prints the token once. `list` also shows legacy tokens (`legacy`); `revoke` takes either. |
| `token recover` | offline | Revoke every owner credential and legacy token, print one new `token` credential, record `token.recover` (alias `bun run --filter @keith/core token:reset`). |
| `groups list\|show <group>\|create <name>\|delete <group> [--yes]\|add <group> <username>\|remove <group> <username>` | socket | Groups for sharing (`acl.md`), owner only. `list` prints name, member count, how many resources use it, the people (a name followed by `!` is suspended or gone) and the date; `create` lowercases the name; `add` needs an active person and is idempotent; `remove` is effective at once, also for queued work; `delete` is refused while a resource uses the group and prints the count. Every change is audited (`acl.group.*`). The `delete` asks first (y/N, naming the group; `--yes` skips it; without a terminal and without `--yes` it exits 2 and changes nothing.) |
| `plugin list\|show <id>\|enable <id> [--yes]\|disable <id> [--yes]` | socket | The built-in plugins (`plugins.md`, "Operator surface"), owner only. `list` prints id, status (`enabled`, `disabled`, `failed`; `(disabled at next boot)` after a toggle), version, reviews waiting and title; `show` adds the reason of a failure, timers waiting, the capabilities a plugin declares and its operations; `enable` and `disable` save the setting `plugins.<id>.enabled` and **take effect at the next boot of the core** (the output says so; restart `keith-core`). Audited (`plugin.enabled`, `plugin.disabled`). `enable` and `disable` ask first (y/N, naming the plugin; `--yes` skips it; without a terminal and without `--yes` it exits 2 and changes nothing.) |
| `guests status\|enable\|disable\|set\|kill\|list\|peek <id>\|end <id> [--yes]` | socket | Anonymous guest mode (`guests.md`), owner only. `set --trusted-proxy none\|cloudflare\|x-forwarded-for --proxy-addr <ip\|cidr>` (repeatable) sets the trusted reverse proxy (step-up, audited; ADR-0027 §21). `status` prints on/off/KILLED, the `guest` model (flagged UNPRICED when the catalog has no price), sessions open, caps, today's and the month's spending and the owner's budget left; `enable` is refused until a priced `guest` model is picked (`model set guest <connection:model>`) and also lifts the kill switch; `disable` ends every session; `kill` is the kill switch (ends every session, refuses entry until `enable`); `list` shows live sessions (random id, zone, IP hash, turns, cost; never text); `peek <id>` prints the live transcript of one session (audited as `guest.peek`, and the visitor is told an owner can watch); `end <id>` ends one. Audited (`guest.settings`, `guest.killswitch`, `guest.session.ended-by-owner`, `guest.peek`). `end` asks first (y/N, naming the session; `--yes` skips it; without a terminal and without `--yes` it exits 2 and changes nothing.) |
| `reviews list [status\|all]\|approve <id>\|deny <id> [reason...]` | socket | What plugins hold for the owner (`plugins.md`, "Owner review queue"). `list` shows pending reviews by default (id, `plugin.operation`, requester, status, date, the payload as one line of **data**); `approve` replays the operation as the requester, whose status and rights are read again now, and prints the outcome (exit 1 when the run failed; a suspended requester is refused and the review stays pending); `deny` takes an optional reason the requester can read. Audited (`plugin.review.approved`, `plugin.review.denied`, never the payload). |
| `presence <username>` | socket | A person's presence as it is computed now, the raw record (`parietal.md`): the state, the manual status with its end, the active client and the online count, then one line per client (id, kind, label, online or offline, last seen, last active). Owner only (`admin.presence.read`); audited as `presence.read` with the person as subject. The front agent never quotes this record: only the disclosure rule releases a line to a model. |
| `notify <username> <text…>` | socket | The owner's test notice through the real delivery path (`delivery.md`, "Owner's test notice"): a client that declared `notify` shows a toast, otherwise the front session stores it as a note. Prints where it went (the client id or the front session), or the queue or failure reason. Owner only (`admin.notice.send`, step-up over TCP); audited as `delivery.test_notice` with the person and the outcome, never the text. Text 1 to 500 characters. |
| `acl show <kind> <id>\|share <kind> <id> <target> <r\|rw\|rwx\|1-7> [--deny]\|unshare <kind> <id> <target> [--deny]\|chmod <kind> <id> <mode>\|chgrp <kind> <id> <group\|->\|chown <kind> <id> <username> [--yes]` | socket | Who reaches a resource (`acl.md`, "Changing access"), as the owner. `show` prints an `ls -l`-like line (mode, owner, group, kind, id) and one line per entry; looking at a member's resource is audited. Targets are `user:<name>`, `group:<name>`, `@users`, `@public`. A kind must be registered by a plugin first (core has none yet). `chown` asks first (y/N, naming the new owner; `--yes` skips it; without a terminal and without `--yes` it exits 2 and changes nothing.) |
| `audit mine [<username>] [--limit n]` | socket | The lines about a person (`auth.md`, "Member view"): when, who, what, newest first; default the caller's own, and the owner names a member to show them their lines (`admin.audit.mine` with `person`). No address, no listener, no raw detail. |
| `approvals ttl [hours]` | socket | How long a pending approval waits for an answer (ADR-0027 §10): with no argument it prints the hours (default 24, max 168); with a whole number 1 to 168 it sets them (`admin.approvals.set`, `settings.manage`, audited as `settings.approvals.set`). An older request is denied as `expired` (`amygdala.md`); a lifetime at or below the ping is refused (see `approvals ping-before`). |
| `approvals ping-before [hours]` | socket | How many hours before expiry the owner is pinged about a waiting approval (`approvals.pingBeforeHours`, default 2): with no argument it prints the hours; with a whole number of at least 1 it sets them (`admin.approvals.set`, `settings.manage`, audited as `settings.approvals.set` with `{ key, from, to }`). The core refuses a ping at or above the lifetime (`amygdala.md`). |
| `protocols list` / `protocols show <id>` / `protocols pause <id> [--until <time> \| --hours <n>]` / `protocols resume <id>` / `protocols delete <id> [--yes]` / `protocols runs <id> [--limit n]` | socket | The owner's view of the protocol engine (hypothalamus.md, "CLI"). `list` prints name, id, owner, trigger and state (`on`, `off`, `paused until <time>`); `show` prints the trigger and every step; `pause` with no end switches the protocol off until `resume`, which switches it on and ends a pause; `--until` takes ISO 8601 (UTC without a zone) or epoch ms, `--hours` a whole number 1 to 8760; `delete` asks first (y/N) and outside a terminal needs `--yes`, its run history stays; `runs` lists the newest runs (default 20). Calls `protocols.*`: `chat` for the owner's own rights, the service decides what the caller sees. |
| `protocols settings get` / `protocols settings set [--tick-ms <ms>] [--max-per-person <n>] [--max-runs-per-day <n>]` | socket | The protocol engine's settings (hypothalamus.md "Settings"): the tick (5 000 to 60 000 ms, default 15 000) and the caps per person (protocols 1 to 100, default 20; runs a UTC day 1 to 200, default 20). `get` needs `settings.read`; `set` is `protocols.settings.set` (`settings.manage`, step-up from a remote caller, audited as `settings.protocols.set` with `{ from, to }`). An out-of-bound value is refused and nothing is written. The `protocols` group takes the protocol verbs of P28.3.3 as more positionals. |
| `succession status` / `succession heir set <username> [--yes]` / `succession heir clear [--yes]` / `succession window <days>` / `succession pause <days \| time>` / `succession resume` | socket | The owner-absence succession (succession.md, "CLI and TUI"). `status` prints `succession: off` without an heir, else `armed (heir, window)`, `grace until` or `claimable since`, then the state, the heir, the window, the age of the owner's last sign in days (`never` when none is known) and any pause; it never prints the signals. `heir set` and `heir clear` ask first (y/N, `--yes` skips it; outside a terminal without `--yes` exit 2); the heir is named by username. `window` takes whole days (the core keeps 7 to 90); `pause` takes a number of days from now or a time (ISO 8601, UTC without a zone, or epoch ms), at most 180 days ahead; `resume` ends a pause early. Calls `admin.succession.get|setHeir|clearHeir|setWindow|pause|resume` (`succession.manage`; the changes need a step-up over TCP; the local socket is stepped up already); the core answers every refusal. The doctor's `succession` line is read only. |
| `rooms list [--limit n]` / `rooms show <id>` / `rooms end <id> [--reason <text>] [--yes]` | database (`list`, `show`); socket (`end`) | The owner's view of the shared rooms (corpus-callosum.md, "CLI and TUI"). `list` prints one row per room, newest first (default 50, `--limit` 1 to 200): id, state (`open`, `active`, `ended`), name, and the active members with `(+ n invited)`. `show` prints the header of one room (id, name, state, initiator, timestamps, the end and its reason) and each member with status, since and left. `list` and `show` open the database read only (refused as not set up, behind or unreadable, like `doctor`), never touch the socket, and print headers only: no transcript text (the audited owner read is `rooms.events` in the TUI). `end` calls `rooms.end` on the running core (refused while the socket does not answer), with the optional reason (up to 200 characters); the core checks the control rule and writes `room.end`, plus `room.owner-end` when the owner did not start the room. The local socket is the owner's, so the commands act as the owner. `end` asks first (y/N; `--yes` skips it; without a terminal and without `--yes` it exits 2 and changes nothing.) |
| `persona show` / `persona history` / `persona template <id> --yes` | database (`show`, `history`); socket (`template`) | The persona (prefrontal.md, "CLI"). `show` prints the current template, version, last change and the text of the persona (template, tone, attitude, humour, addressing, cares about, the two fixed lines). `history` prints every version, newest first: version, time, reason (`template`, `edit`, `restore`), template and who changed it. Both open the database read only (refused as not set up, behind or unreadable, like `rooms list`) and never touch the socket. `template <id>` takes a built-in template (`butler`, `friend`, `professional`); without `--yes` it changes nothing and says so (exit 0); with `--yes` the running core changes it (`persona.setTemplate`), which checks the owner and writes one version and one `persona.change` row. The local socket is the owner's, so the command acts as the owner. An unknown template is a usage error (exit 2). |
| `audit retention [show\|set <days>]` | socket | How long the audit log is kept: `show` prints the days (default 180); `set` takes 0 to 3650 and **0 keeps everything** (nothing is ever pruned). Owner only, audited. |
| `audit [--limit n]` | socket | The whole security log, newest first (default 50, max 500): time (UTC), kind, actor, via, detail. Owner only (`audit.read`). |
| `logs list [--kind k] [--person u\|everyone] [--model m] [--since 12h\|7d\|date] [--limit n] [--json]` / `logs show <sessionId> [--json]` / `logs call <callId> [--json]` / `logs raw <callId> [--part request\|response] [--json]` / `logs settings [--capture-bodies on\|off] [--guest-bodies on\|off] [--body-days n] [--meta-days n] [--max-body-bytes n]` / `logs prune` | socket; `prune` needs the core stopped (the database is read directly) | The model-call log (`activity-logs.md`, "CLI"). `list` prints one row per session, newest first (last activity, kind, app, id, primary model, calls, cost); `--person` takes a username, `everyone` lists every person (the owner only). `show` prints the overview and its generations; `call` prints the figures, the messages sent and the tool calls of one call; `raw` prints the redacted request or response JSON, size-capped. `list`, `show`, `call` and `raw` are owner reads of another person through the owner path of the RPC, so the rows `logs.owner-read` and `acl.owner-access` are written (every `raw` read). `settings` with no flag prints the settings; with flags it changes them after the contract bounds and the bodies-no-longer-than-figures rule are checked, audited `logs.settings` (field names only). `prune` deletes now what the retention would delete later (the periods of the prune tick), and audits `data.pruned` per table. |
| `db migrate` | offline | Create or upgrade the database (alias `bun run db:migrate`). Takes `core.lock` (refused while another process holds it), refuses a database a newer build wrote, snapshots a behind one first (`migrateWithBackup`, `db.md`) and prints the block (`database <file> was behind: applying N migration(s): <tags>; backup <path>`). |
| `backup [--out <dir>]` | either | Writes `keith-backup-<stamp>.tar` (0600) with a `VACUUM INTO` copy of the database (checked with `integrity_check`), `secret.key`, `instance-id`, `workspace/` and `memory/`, and a `manifest.json`; into `<data>/backups/` or `--out`. Works while core runs (no lock). Prints the path, the size and what it includes; warns when the archive holds the key, and says the key is NOT in it when it comes from `KEITH_SECRET_KEY`. Audited `backup.created`. Contract: `backup.md`. |
| `restore <archive> [--force]` | offline | Puts a `backup` archive back into the data folder. Core must be stopped (takes `core.lock`). Refuses an archive from a newer Keith, a damaged database inside it, an unexpected entry or no manifest, and a data folder that already holds the database or key without `--force`; `--force` moves what is there to `restore-previous-<stamp>/` (nothing is deleted). Prints what it restored and `run keith-core doctor, then keith-core start`. Audited `backup.restored`. Contract: `backup.md`. |

Other `bun run` aliases: `start`/`dev` (`main.ts`): refuse a folder that was never set up (exit 2, `run keith-core setup`) and apply the same owner sign-in check as `start`.

## Setup flags

`--owner-name`, `--owner-username`, `--owner-pin-stdin`, `--owner-password-stdin`, `--provider openrouter|openai|deepseek|skip` (any registered id), `--api-key-stdin`,
`--skip-test`, `--front-model`, `--cortex-model` (bare id or `connection:model`), `--budget <usd|none>`
(default current, else 20), `--access local|remote`, `--public-url`, `--bind`, `--non-interactive`.

- Prompts only when stdin and stdout are terminals and `--non-interactive` is absent. Otherwise a
  missing answer with no default is a usage error naming the flag (`missing --owner-name`, `missing
  --provider ...`, `missing --api-key-stdin`, `missing --front-model` when no suggestion exists), exit 2.
  Defaults: the current value on a re-run, the provider's default model, budget 20, access local.
- API key source order: `--api-key-stdin`, the key in the environment (`OPENROUTER_API_KEY` etc.,
  offered in a prompt, used when headless), the saved key (kept), then a hidden prompt.
- The key is tested before it is saved: it is stored under the temporary id `setup-probe`, tested
  and removed; only a passing key is written under the real id. A failure is exit 1 headless, or
  asks to retry or save anyway on a terminal. `--skip-test` saves without testing.
- **Owner sign-in (required).** Every install ends with an owner who can sign in: at least a PIN
  (6 to 12 digits) or a password (rules and blocklist of `auth.md`). A terminal asks for the username
  (default: the current one, `owner` before any rename; `--owner-username`, 2-32 of `a-z 0-9 . _ -`; a name another person has is refused; the change goes through the people service and is audited `via: offline`, FD10-03). This is asked first, before any other answer is saved, the PIN twice (hidden) and offers a password
  (also twice, hidden). Headless, the secret comes from stdin and never from argv: `--owner-pin-stdin` reads one
  line, `--owner-password-stdin` the next one (order on stdin: API key, PIN, password). A refused secret is a usage
  error (exit 2) that says why. With no flag and no credential yet, headless setup fails (exit 2,
  `the owner needs a way to sign in: pipe a PIN with --owner-pin-stdin`) and does not mark setup done. Re-running
  shows that the owner already signs in and keeps it (a terminal asks "Change it?", default no; a flag changes it).
  Stored like `people pin` / `people passwd` (argon2id in `person_secrets`), audited as `person.secret.set` and
  one `setup.owner_signin` row (`methods`, `via: offline`, never a secret). The summary prints `sign-in  pin`.
- Models are checked against the provider's list when it can be listed; the suggestion is the
  stored pick, else the provider default (`PROVIDER_DEFAULTS`).
- Stored: owner display name in `people.name` (the current owner's row, whatever its id after a transfer; written through the people service, so audited as `person.update` with `via: offline`, FD13-03), `setup.done` and `setup.completedAt`
  settings, `model.front`, `model.cortex`, `model.guest`, `guests.*`, the budget limit, `access.mode`, `access.host`,
  `access.publicUrl`. The bind address defaults to `127.0.0.1` (local, or remote behind an https proxy
  such as `tailscale serve`) and to `0.0.0.0` otherwise.

## Setup wizard

`keith-core setup` opens the wizard when stdin and stdout are terminals, `--non-interactive` is absent
and no answer flag is given (`--owner-name`, `--provider`, `--api-key-stdin`, `--skip-test`,
`--front-model`, `--cortex-model`, `--budget`, `--access`, `--public-url`, `--bind`). Anything else
runs the line-prompt flow described under Setup flags, unchanged.

Steps, with `shift+tab` (or `ctrl+b`) back, `enter` next, `esc` cancel and a `step n of N` indicator:
name; provider (openrouter, openai, deepseek, skip); connection (API key typed hidden, or reuse the
environment's or saved key, then the test, with "try another key" and "save it anyway" on a failure);
front and cortex models (suggestion filled in, checked against the provider list when it was
listed); budget; access (local or remote, then the public URL); **owner sign-in: the PIN is required** (hidden, typed
twice, rules of `auth.md`; with an owner who already signs in, Enter keeps it); summary. The wizard sets a PIN; a
password (or another username) is set with the flags or `people passwd` later. Without a connection (provider skipped and none saved) the
connection and model steps are left out.

- The wizard **saves nothing until the summary is confirmed**, then writes everything in the order of
  the line-prompt flow (name, provider, models, budget, access, PIN, `setup.done`). `esc` or Ctrl+C
  writes nothing, not even a tested key (the test uses the `setup-probe` connection and removes it).
- The API key and the PIN live in refs of the component, never in rendered state: the inputs are masked
  and emptied after submit, and the refs are cleared after the save, on cancel and when going back.
- Writing the owner PIN offline hashes it with argon2id (`createHasher`) into `person_secrets` and
  records `person.secret.set` (`via: offline`).
- Both front ends share `cli/setup-steps.ts` (validation, defaults, provider probe, role models, budget,
  access, PIN, summary text) and the wizard saves through `cli/setup-apply.ts`; neither has its own copy
  of the rules, so they store the same settings.

## Precedence of bind and URLs

For host and public URL: environment (`KEITH_HOST`, `KEITH_PUBLIC_URL`), then the database
(`access.host`, `access.publicUrl`), then the default (`127.0.0.1`, none). The port is
`KEITH_PORT` or 7420. The data dir is `KEITH_DATA_DIR`, else `<KEITH_HOME>/data`, else `<repo>/data`.
`effectiveNetwork(config, settings)` computes it and `config show` prints the source of each value.
The public URL and `access` mode apply live; a changed bind address needs a restart
(`admin.access.set` returns `restartRequired`). Provider keys from the environment are read-only
connections that win over a saved connection with the same id.

## Settings keys

`setup.done`, `setup.completedAt`, `access.mode` (`local|remote`), `access.host`, `access.publicUrl`, `access.proxy` (`none|tailscale-serve`),
`model.front`, `model.cortex`, `model.guest`, `guests.*`, `approvals.ttlHours` (1 to 168, default 24), `approvals.pingBeforeHours` (1 to below the TTL, default 2), `protocols.tickMs`, `protocols.maxPerPerson`, `protocols.maxPerPersonRunsPerDay` (hypothalamus.md "Settings"), `nodes.sandbox.maxPerHourPerPerson` (1 to 1000, default 60; read by motor.md, the calls per hour one person may make to a capability that runs without asking), `budget.seeded` (and the budget ledger), `auth.policy`, `auth.local` (`{ idleMinutes, trust }`). Owner name: `people.name`.

## Backup, restore and upgrade order (ADR-0027 §25)

`keith-core backup` and `keith-core restore` share one archive contract, `backup.md`. `backup` works while core runs (the
database is copied with `VACUUM INTO`, so the copy is consistent); `restore` runs only while core is stopped.

## Upgrading and rolling back

The owner's order for an upgrade (mirrored in `docs/deploy/README.md`, "Updating"):

1. `keith-core backup` (the core may keep running). Copy the archive off the machine if it matters.
2. Stop the core service. Nodes may stay up: they reconnect.
3. `git pull && bun install` (and `bun run link` if commands changed).
4. `keith-core doctor --offline`: a database that is behind shows in the `database` line (`missing or behind`, `✗`, with the hint to run `db migrate`); a database a newer build wrote shows as refused.
5. `keith-core start` (or `keith-core db migrate` to migrate without serving). Before the first migration Keith writes `backups/keith-<timestamp>.db` and prints the list of migrations it applies; if the snapshot fails, nothing is migrated.
6. `keith-core doctor`, then open `keith`. Update nodes afterwards (`git pull` on each machine, restart `keith-node run`): the core accepts every node at or above `MIN_PROTOCOL`.
7. Roll back: stop the core, check out the previous tag, then `keith-core restore <archive from step 1> --force`. An older Keith
cannot read a database that a newer one migrated, so restore the copy made before the upgrade. The `--force` moves the
upgraded files to `restore-previous-<stamp>/`. For a `backups/keith-<timestamp>.db` snapshot alone (it holds the database
only, not the workspace or memory), stop the core, remove `keith.db-wal` and `keith.db-shm`, and copy the snapshot over `keith.db`.

## The admin session (`local trust: none`)

Every command marked `socket` goes through `connectLocal`. `local trust: none` is the default, so a command that gets `401` asks for the
owner's PIN (hidden; `CliDeps.askPin` in tests), buys a 5-minute admin session (`POST /auth/local/session`) and keeps it **in the memory of that
process**: nothing is written to disk, so the next command asks again. `eval "$(keith-core login)"` asks once and exports `KEITH_ADMIN_SESSION`
(read in `platform/config.ts`) in that shell only; `eval "$(keith-core logout)"` revokes it and unsets it; both refuse to print on a terminal
(the token would reach the scrollback). A wrong PIN is `keith-core: Wrong PIN.` (exit 1). With an implicit owner (`idle-lock`, `full`) nothing is
asked. A locked socket (`423`) says to run `keith unlock`. `auth local set` also works with the core stopped (offline, audited `via: offline`, with the same lockout guard as the RPC for `--trust none`):
the way back from a forgotten PIN is `keith-core auth local set --trust full --yes`. See `auth.md`, "The admin session".

## Socket path

`socketPathFor(dataDir)` (`modules/local-socket`): `<dataDir>/core.sock`, or
`$TMPDIR/keith-<hash>.sock` when that is over 100 bytes; core records the fallback in
`<dataDir>/core.sock.path` while it runs. Both server and CLIs call this one function.

## Lock file

`<dataDir>/core.lock` holds a pid, created exclusively (mode 0600). `start` holds it for the life
of the process; offline commands hold it while they run. A lock whose pid is not alive is stale and
is taken over; a live one stops the command (`another keith-core process (pid N) holds ...`).
The takeover is atomic (F-026, P26.1.1): under a guard `core.lock.takeover` (created exclusively) the
taker re-reads the pid, removes the stale lock and creates its own with the same exclusive create. A
process that finds the guard waits up to 2 s (20 ms steps) and starts again; a guard older than 10 s
belongs to a dead process and is removed. Of several processes that find one stale lock, exactly one
takes it. A live holder is refused whatever the guard says. `start` also refuses when the socket
answers (`core already running`).

## Contract additions (`packages/contracts`)

`admin.access.get|set` (`Access`, `AccessSet`: mode, host, port, proxy, publicUrl, restartRequired),
`admin.tokens.list|create|revoke` (`TokenInfo` with `legacy` and `lastSeenAt`, `TokenCreated`),
`admin.devices.list|approve|deny|revoke`, `admin.sessions.list|revoke`, `admin.auth.policy.get|set`, `admin.audit.list|retention.get|retention.set`, `admin.groups.list|get|create|delete|add|remove` (`acl.md`), `admin.presence.read` (`parietal.md`), `admin.notice.send` (`delivery.md`), `admin.reviews.list|approve|deny` and `admin.plugins.list|show|views.list|enable|disable`, `admin.capabilities.list` (`plugins.md`), `admin.guests.get|set|killswitch|list|end|peek` (`guests.md`), `admin.people.list|get|add|rename|setRole|suspend|reactivate|remove|transferOwner|setPassword|setPin|clearSecret|unlock|grants|grant|revokeGrant` (`people.md`) and `auth.logout`. Every procedure declares a capability (`permissions.md`); the socket is the owner and always stepped up. The rpc context is
`{ principal, capabilities, via, ip, record }`.

## Exit codes

0 ok; 1 runtime failure (including a refused channel, a failed provider test, `doctor` with a `✗`,
`status` when down); 2 usage error; 130 cancelled (Ctrl+C in a prompt).

`start` (core in the foreground): 0 after a clean stop on SIGINT or SIGTERM; 1 when the stop failed or was forced
(10 s cap), on a second signal during the stop, or after an uncaught exception or unhandled rejection (`logging.md`, Shutdown and crash); 1 also on a `StartError` such as an already running core.

## For the next steps

TUI and node: `socketPathFor(dataDir)` and `probeSocket` come from `modules/local-socket` (the TUI
may duplicate the path rule from this spec; it cannot import apps/core); `createKeithClient` takes no
token with `fetch: (u, i) => fetch(u, { ...i, unix: path })`. Smoke (`scripts/smoke.ts`) drives
`setup --non-interactive`, `start`, `status`, `devices`, `token create`, `pair` and `audit`. The client helper for device login is `deviceLogin`
in `@keith/client` (`client.md`); a client that wants to show the code and wait calls it, then
stores the returned credential as its `token`.

## Tests

`cli/setup-wizard.test.tsx`: a full wizard pass stores the same settings as the flag flow (plus the PIN)
and no frame ever shows the key or the PIN, back keeps answers and drops the connection steps when
the provider is skipped, the PIN confirmation, Esc saves nothing (not even a tested key), a failed
key test saves nothing, the lock refuses a second writer. `cli/console.test.tsx`: no arguments without
a terminal or with `--help` prints help, the launcher picks wizard, home or hand-over, Start runs in
process, a missing `keith` prints the command and `bun run link`, `setup` picks wizard or prompts, the
home screen and its doctor on screen. Both use `@keith/ui/testing` and fake probe, spawn, `which` and
screens (`CliDeps.console`).
`apps/core/src/cli/cli.test.ts`: headless setup (stored values, no token minted, lock released),
missing flag exit 2, re-run defaults, key tested before saving (nothing saved on failure), `start`
without a terminal exit 2, `status`/`config show`/`access`/`budget`/`model`/`provider`/`token`/`pair`
over a real socket against an in-process core, offline refusals while the socket answers, online
refusal when down, `token recover`, second `start` refused, `doctor`.
`modules/people/secrets.test.ts`: `people passwd|pin|unlock|clear-*` with stdin, rule refusals, no-stdin refusal and the audit events.
`modules/people/people.test.ts`: the `people` commands over a real socket (add, list, username rules, rename, suspend and reactivate against a member credential, remove, transfer-owner, the owner refusals, audit events).
`cli/auth-commands.test.ts`: `devices` (list, approve with label, credential works, revoke, deny, wrong code), `token` (credentials, legacy marked and revocable, recover revokes both and is audited), `audit` (order, limit, empty), `access --proxy`.
`modules/admin/lockfile.test.ts`, `modules/local-socket/local-socket.test.ts`,
`modules/thalamus/principal.test.ts`.
