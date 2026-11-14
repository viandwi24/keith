# Keith guide

Everyday use of Keith, from the first run to nodes, rooms and evals. For the overview see the [README](../README.md); to test
Keith step by step, follow [manual-testing.md](manual-testing.md). Where this page and a spec disagree, the spec in
[specs/](specs/) rules.

## First run

Set up once, then start the core:

```sh
bun install
bun run link                      # puts keith-core, keith and keith-node on your PATH (bun link)
keith-core setup                  # name, AI provider, models, monthly budget, access
keith-core start
```

`setup` opens a full-screen wizard (name, provider, models, budget, access, owner PIN) and tests your
API key before saving it. `keith-core` with no command opens the console: the wizard on a fresh
install, Start and Doctor while core is stopped, and the Manage screen while it runs. Without `bun run link`, run
`bun apps/core/src/cli.ts <command>` (and `bun apps/tui/src/cli.tsx`, `bun apps/node/src/main.ts`) instead
of the three commands. Run core as a service: [docs/deploy/](deploy/README.md) (launchd, systemd,
untested container recipe). Headless (CI, containers):
`printf '%s\n%s\n' "$KEY" "$PIN" | keith-core setup --non-interactive --owner-name viandwi24 --provider openrouter --api-key-stdin --owner-pin-stdin` (the owner needs a PIN or password to sign in).
The core listens on `http://127.0.0.1:7420` (change it with `KEITH_PORT`; `KEITH_HOST` and
`KEITH_PUBLIC_URL` override what `keith-core access` saved). It binds to loopback by default. Boot no
longer prints a token: every `keith-core` command that changes something talks to the running core over
an owner-only Unix socket in the data folder, and asks for the owner's PIN or password first (local trust
`none` is the default; `eval "$(keith-core login)"` keeps a short session in one shell) (`keith-core status`, `provider`, `model`, `budget`,
`access`, `pair`, `nodes`, `token`, `config show`, `doctor`). Details: [docs/specs/core-cli.md](specs/core-cli.md).
(`bun run dev` starts the core, a node and the TUI together; the core needs `keith-core setup` first.)

## TUI

`keith` opens Home (the orb and the brain trace; `enter` for the chat, or `keith chat` directly). `keith manage` (or `/manage` in chat) opens the Manage screen:
people, devices and tokens, nodes, providers and models, access, budget and audit, shown by role;
remote changes ask for your PIN. Every action is also a `keith-core` command for scripts. On the core
machine it finds the core's local socket in the data folder and opens the Sign in panel: the socket is not
an implicit owner by default (local trust `none`), so the owner signs in with the PIN or password. An owner who
accepts the risk can opt in to `idle-lock` or `full` with `keith-core auth local set` ([docs/specs/auth.md](specs/auth.md)).

```sh
keith-core start        # core machine, one tab
keith                   # core machine, another tab: sign in with your PIN, then chat
```

From another device (laptop to laptop; a phone needs the web UI, which comes later) sign in inside the app:
`keith login --core http://100.64.0.1:7420` (or just `keith`, then `enter` on the signed-out Home, or `/login`) opens the
Sign in screen. Pick a device code, a username and password, or a token. A device code is approved on the core machine:

```sh
keith login --core http://100.64.0.1:7420
# the screen shows: Login code ABCD-EFGH (valid for 10 minutes)
keith-core devices approve ABCD-EFGH    # on the core machine
```

Inside the app `/login`, `/logout` and `/whoami` work at any time. `keith whoami` and `keith logout` also exist as plain commands.

## People and roles

Keith has one owner and any number of members, each with their own conversation,
memory and optional spending cap. On the core machine: `keith-core people add ana --name Ana`, then
`keith-core people passwd ana` (a passphrase of 15+ characters) and `keith-core people pin owner` (the PIN
that confirms sensitive actions from a remote client). Ana signs in from a terminal on this machine or over
Tailscale on the Sign in screen (`keith login`, then Username and password); a member's shell command waits for the owner's approval. See
[SECURITY.md](../SECURITY.md) and [docs/specs/permissions.md](specs/permissions.md). What the owner can see of a member's data, and how sharing works,
is in [docs/sharing-and-privacy.md](sharing-and-privacy.md).

## Shared rooms (group call mode)

The owner, or a member with the `rooms.start` right, can start a room: invited people accept and then talk to
the same Keith in one text conversation (`/room start <names>`, `/room end`; the TUI shows the room on Home and in the chat). Keith answers from what
the room said and what each person disclosed; personal requests go to the speaker's own chat. Rules: [docs/sharing-and-privacy.md](sharing-and-privacy.md).

## Persona and answer modes

Keith has one persona, a versioned character the owner picks from a built-in template (`butler`, `friend`,
`professional`) and edits with the PIN (`/persona`, `/persona template <id>`, Manage → Persona; `keith-core persona`). Each person sets a few
style things for themselves (`/persona style`: how to be addressed, language, brevity, formality, gentle topics). Keith picks how to answer from the
channel and the request: spoken in full sentences on a speech channel, Markdown only where the client renders it, and a one-to-three sentence
conclusion for reports, with long results saved as a document. The persona is not a privacy boundary ([docs/sharing-and-privacy.md](sharing-and-privacy.md)).
Spec: [docs/specs/prefrontal.md](specs/prefrontal.md).

## Scripted login and client files

For scripts, the flags keep the text flow: `keith login --token` reads a token from a hidden prompt or stdin, and `--device`, `--password --username <name>` and a pipe never open the screen. The login is saved in
`~/.keith/client.json` (mode 0600); `KEITH_CLIENT_CONFIG=/path/client.json` uses another file;
`KEITH_HOME=/folder` moves all defaults at once (core data to `/folder/data`, `node.json`, `client.json`,
the node workspace), so a test login never overwrites the real one. `keith --core unix:<path>` or
`--core <url>` picks a core explicitly. Without a flag `keith` uses `client.json`, else the local socket.
(From a checkout, `bun run start` in `apps/tui` runs the same program.)

## Provider and models

The provider and models are set on the Manage screen or with `keith-core provider add openrouter`
(OpenRouter, OpenAI or DeepSeek; the key is stored encrypted), then `keith-core model set front <id>` and
`keith-core model set cortex <id>`. A connection can also come from the environment
(`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, read-only). Typing `/connect`, `/model` or
`/pair` in the TUI prints the matching `keith-core` command.

## Pairing a node

On the core machine run `keith-core pair` to get a code and the command. On the node machine:

```sh
keith-node setup                 # interactive; or:
keith-node join --core <url> --code <code> [--allow-shell]
keith-node run
```

`shell.exec` always asks for the owner's approval in the TUI, and `--allow-shell` is off by default.
Set `KEITH_PUBLIC_URL` on the core so the `pair` command uses an address the node can reach.

## Node drivers: desktop, sandbox

A node adds capabilities through drivers: `keith-node driver list`, then
`driver add desktop` (screenshots; `--allow-input` for mouse and keys; macOS Screen Recording and Accessibility are granted by hand to the
terminal that runs `keith-node`), `driver add sandbox` (code runs in a disposable Docker or Podman container, with no network unless
`--network`), and `driver remove <name>`. Each change takes effect after a restart of `keith-node run`. Every risky call asks the owner first.
Tests never touch a real screen or a container runtime. Spec: [docs/specs/node-drivers.md](specs/node-drivers.md).

## Access from another machine (Tailscale)

The core has no TLS, so do not expose it to the
internet. Use Tailscale or a private network: set `KEITH_HOST` to the core machine's Tailscale IP and
`KEITH_PUBLIC_URL` to the same address, e.g. `KEITH_HOST=100.64.0.1 KEITH_PUBLIC_URL=http://100.64.0.1:7420`.
A non-loopback host makes the core print a warning at boot.

## TUI commands


| Command | What it does |
| --- | --- |
| `/tasks` | All tasks (Enter for the summary, `s` to stop) |
| `/nodes` | Node list (read only; revoke with `keith-core nodes revoke`) |
| `/budget` | This month's cost and the monthly limit, read only (change it with `keith-core budget set`) |
| `/whoami` | Person, core and how you are connected |
| `/continue`, `/retry` | Continue an interrupted turn, or redo its answer |
| `/brain trace` | The last 50 brain events |
| `/help`, `/quit` | Help, quit |

## Data and logs

All of it lives in `data/` (change it with `KEITH_DATA_DIR`, or `KEITH_HOME` for `<home>/data`): `keith.db` (the database),
`memory/<personId>/` (Keith's memory about each person, markdown files you can read and edit; the first owner's folder is `memory/owner/`),
`logs/keith-YYYY-MM-DD.log` (one JSON object per line, secrets masked, kept 14 days), `evals/`
(eval reports) and `instance-id`.

## Remote access

Connections do not use TLS. For a TUI or node on another machine use
[Tailscale](https://tailscale.com) (or another private network); do not open the core port to the internet.
TLS follows with the web UI.

## Real-model eval

Runs the "show me the news" scenario with a real model (it costs money; the
default cap is 0.5 USD per run):

```sh
OPENROUTER_API_KEY=... bun run eval:news
```

The report is written to `<KEITH_DATA_DIR>/evals/` (default `data/evals/`; `--out <folder>` replaces it). Add `--scripted` to run the same path
offline without a key.
