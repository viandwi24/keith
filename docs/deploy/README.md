# Running Keith core as a service

Core is `keith-core start`. These files keep it running after a reboot. Nothing here is built or
tested by CI; try it and run `keith-core doctor` afterwards.

| File | For |
| --- | --- |
| `launchd/dev.keith.core.plist` | macOS, per-user launch agent |
| `systemd/keith-core.service` | Linux, system or user unit |
| `container/` | Docker or Podman recipe (untested, see its README) |

## Before you install

1. Install from a checkout (`bun install`, `bun run link`) and run `keith-core setup` once as the
   user that will run the service. Setup writes the database, the secret key file and your choices
   into the data folder.
2. Edit the paths in the file: the user, the `bun` binary (`which bun`), the checkout and the data
   folder.

## Environment

| Variable | Meaning |
| --- | --- |
| `KEITH_DATA_DIR` | Data folder (database, `secret.key`, memory, logs, `core.sock`). Keep it mode 0700. |
| `KEITH_PORT`, `KEITH_HOST` | Listen port and bind address. Setup stores them; the variables override. |
| `KEITH_PUBLIC_URL` | URL other devices use. Its host joins the Host allowlist. |
| `KEITH_PUSH_SUBJECT` | Web Push VAPID subject: a `mailto:` or https URL. Default: the public URL when it is https (`docs/specs/push.md`). |
| `KEITH_ALLOWED_HOSTS` | Extra host names core answers to (comma list), for proxies. |
| `KEITH_WEB` | `off` stops core serving the web client at `/app` (default `on`). |
| `KEITH_WEB_DIR` | Folder of the built web client (default `apps/web/build`; build it with `bun run --cwd apps/web build`). |
| `KEITH_SECRET_KEY` | 32 bytes base64. Replaces the key file; use it when the data folder is disposable. |
| `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY` | Read-only provider connections from the environment. |

Keep secrets out of the unit or plist: use `EnvironmentFile=` (systemd, a root-only file) or let
`keith-core setup` store the key.

## Operating it

- Admin commands (`keith-core status`, `devices approve`, `pair`, ...) talk to the running service
  through `<data dir>/core.sock`. Run them as the same user, with the same `KEITH_DATA_DIR`.
- `keith-core setup` and `token recover` need core stopped (stop the service first).
- A laptop that sleeps stops core and drops its nodes; they reconnect on wake. For an always-on
  core use a machine that does not sleep (on macOS, `caffeinate -s` or Energy settings: "Prevent
  automatic sleeping when the display is off").
- After installing, run `keith-core doctor`. It checks the data folder modes, the database, the
  secret key, the provider, the socket and the bind address, and prints a fix for each problem.
- Updating (the order is in `docs/specs/core-cli.md`, "Upgrading and rolling back"):
  1. `keith-core backup` (the core may keep running). Copy the archive off the machine if it matters.
  2. Stop the service. Nodes may stay up: they reconnect.
  3. `git pull && bun install` (and `bun run link` if commands changed).
  4. `keith-core doctor --offline`: a database that is behind is listed in the `database` line.
  5. `keith-core start` (or `keith-core db migrate`). Before the first migration Keith writes `<data>/backups/keith-<timestamp>.db` and prints the migrations it applies; if the copy fails, nothing is migrated.
  6. `keith-core doctor`, then open `keith`. Update each node afterwards (`git pull`, restart `keith-node run`).
  - Rolling back: stop the service, check out the previous tag, and `keith-core restore <archive from step 1> --force`. A database a newer build wrote is refused by an older one, so the restore is required. Keep the snapshot until the new version runs well.
  - `keith-core backup` is not scheduled: run it from cron (for example daily) and keep the archive off the machine. `doctor` warns when the newest backup is older than 30 days.
