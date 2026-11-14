# P6 — "Ready to test"

Oct 26, 2026 · closing MVP plan after M4 (`P0-mvp.md`) · status: **done**

## Goal and limits

M0–M4 are built and pass tests with a fake model. P6 makes Keith **testable by viandwi24, professionally
and safely**. P6 is done when:

1. **Safe to use on a laptop.** The core is not exposed to the network by accident, the secret files
   in `data/` are readable only by the owner, and the cross-module security review leaves no open
   high or medium finding.
2. **Proven to run for real.** The real entrypoints (the core's `main.ts`, the TUI CLI, the node
   daemon) are run as processes, not only tested per module, and the basic flow passes.
3. **Testing is guided.** There is a testing guide with scenarios, steps and expected results, plus
   how to reset and how to report a bug.

Not in P6: TLS, the web UI, `act`, push and CI on GitHub, the real-model eval (run by viandwi24 after P6,
through the testing guide).

## Decisions (CTO, Oct 26, 2026)

| Topic | Decision | Basis |
| --- | --- | --- |
| Bind address | `KEITH_HOST`, default `127.0.0.1`. If it is not loopback, the core warns at boot: no TLS, use Tailscale | `Bun.serve` without `hostname` now opens `0.0.0.0` |
| File permissions | `data/` 0700; `keith.db` (+ `-wal`/`-shm`), `logs/`, `memory/`, `instance-id` 0600/0700 | Only `secret.key` and the client/node configs were already 0600 |
| Security review | A read-only subagent with a checklist (below). High/medium are fixed in P6; low ones are recorded in `SECURITY.md` as known risks | There has never been a cross-module review |
| Smoke test | `bun run smoke`: runs the core, the TUI (PTY) and a node as real processes in a temporary data folder, with a scripted provider; not part of `bun run check` | Proves the entrypoint wiring with no key and no cost |
| Real model | Not run by the agent. viandwi24 runs it with his own key through the testing guide | A real key must not be held by the agent |
| Machine load | `bun run check` at most twice per step, smoke once per change, no repeat loops | viandwi24's laptop overheats (memory `keep-machine-load-low`) |

Review checklist: auth and tokens (entropy, hash, constant-time comparison, reset); pairing (TTL,
attempt limit, single-use codes); the node WebSocket (auth before upgrade, message size); motor
(`shell.exec`: approval, minimal env, timeout, process-group kill, `--allow-shell`); the vault and
provider profiles (secrets never return to the client); logs, memory and eval reports (redaction); oRPC
and HTTP (every route needs a token, zod validation, CORS); file permissions; `bun audit`; gitleaks.

## Steps

Done by Sonnet 5.5 subagents, reviewed and committed in the orchestrating session. Steps 1 and 2 can
run in parallel; step 1 only reads.

1. **Security review** (read-only): a findings report with level, location and a proposed fix.
2. **Smoke test** (`scripts/smoke.ts`, `bun run smoke`):
   - a fresh core: the token is printed once, `/health` answers, bound to 127.0.0.1;
   - the TUI logs in with the token, chat without a provider gives a clear message, chat with a
     scripted provider answers;
   - a node joins with the `/pair` code, shows online, `shell.exec` waits for approval;
   - all processes are killed and the temporary folder is deleted, also on failure.
3. **Fixes**: `KEITH_HOST` + a warning, file permissions, then the high/medium findings from step 1.
   A test for each fix; specs and `SECURITY.md` change with them.
4. **Testing guide** `docs/manual-testing.md`:
   - preparation: install, migrate, start, login, an OpenRouter connection, a small budget limit for testing;
   - 8–10 scenarios with expected results: chat, "find A" (delegation and report), remember
     and restart, a dropped connection and `/continue`, shell approval on a node, denying shell, budget
     exhausted, storing an API key (must be refused), the eval `bun run eval:news`;
   - reset (`token:reset`, delete `data/`), where the logs are, the bug report format.

## P6 gate (evidence)

| Evidence | How |
| --- | --- |
| Review | The report is recorded; 0 open high/medium findings; the low ones are in `SECURITY.md` |
| Bind and permissions | Tests: default 127.0.0.1, a warning for non-loopback; file modes in `data/` |
| Smoke | `bun run smoke` green, with no leftover process (`ps`) |
| Quality | `bun run check` green; `bun audit --audit-level=high` clean; `gitleaks git` clean |
| Guide | `docs/manual-testing.md` exists and every command in it was tried once by the agent, except those needing a real key |

After the gate: viandwi24 runs the testing guide with an OpenRouter key. Bugs found become the next plan.
`act` or the real CI is run afterwards.

## Risks

| Risk | Mitigation |
| --- | --- |
| The review finds a lot | Only high/medium are required in P6; the rest is recorded |
| The PTY smoke test is flaky | Use the existing helpers (`Bun.spawn({ terminal })`, `pressUntil`); smoke is outside `check` |
| The 127.0.0.1 default cuts off nodes on other machines | The guide: set `KEITH_HOST` to the Tailscale IP and `KEITH_PUBLIC_URL` |

## Execution notes

Commits: e29018e (plan), a5368ce (smoke), 47054a3 (memory, node, login, motor grant), bcb5fb9 (bind,
request limits, file permissions, logger, `SECURITY.md`), then the testing guide and this archive.

### Security review (Oct 26, 2026)

| Id | Level | Finding | Status |
| --- | --- | --- | --- |
| H1 | high | The core binds to `0.0.0.0` without TLS | Fixed: `KEITH_HOST` defaults to `127.0.0.1`, a warning for non-loopback |
| M1 | medium | `data/` (db, wal, shm, logs, memory, instance-id) was 0644 | Fixed: umask 077, `data/` 0700, files 0600, also for existing installs |
| M2 | medium | Memory was guarded only by the prompt; a worker reading the web could write `profile.md` | Fixed: workers read only; `tool.approve` rejects writes that look like secrets |
| M3 | medium | A node trusts any `http` core (MITM → shell) | Fixed: only loopback/Tailscale/`https`, otherwise `--insecure` is needed |
| M4 | medium | Resource exhaustion before auth (`idleTimeout: 0`, unbounded body) | Fixed: idle 30 s, body 1 MB, join 16 KB; an authenticated stream gets `server.timeout(req, 0)` |
| L3 | low | The motor session grant was per node name | Fixed: per node id |
| L4 | low | Console logs were not redacted; the provider key patterns were incomplete | Fixed; the token line uses `secretOnce` (console only) |
| L5 | low | Database errors went to unauthenticated callers | Fixed: a fixed message |
| L6 | low | The token in argv and in the login hint | Fixed: `login` reads stdin; the hint has no token |
| L1, L2, L7–L10, I1–I4 | low/info | See `SECURITY.md` "Known risks" | Accepted for the MVP |

`keepAlive` was proven separately: Bun with `idleTimeout: 1` cuts a stream that is quiet for 7 s without
`server.timeout(req, 0)` and keeps it with that. The test in `serve.test.ts` does not tell the two
apart (its stream sends data); a 30 s pause is too long for the suite.

### Gate evidence

| Evidence | Result |
| --- | --- |
| Review | The table above: 0 open high/medium; the accepted low ones are in `SECURITY.md` |
| Bind and permissions | `platform/net.test.ts`, `config.test.ts`, `platform/db.test.ts` (umask 022, an old install → everything 0600/0700); smoke: log `http://127.0.0.1:<port>`, a LAN IP is refused; the guide: `curl` to the LAN IP exits 7 |
| Smoke | `bun run smoke`: 6 steps PASS, ~3 s, no leftover process |
| Quality | `bun run check`: 551 pass, 0 fail, 73 files; `bun audit --audit-level=high`: clean (1 moderate below the limit, esbuild via drizzle-kit); `gitleaks git`: no leaks |
| Guide | `docs/manual-testing.md`: the commands without a key were tried in a temporary folder (migrate, core, `/health`, login via stdin, node join/run, LAN `curl`, file modes, `token:reset`, the scripted eval) |

### Rough edges found, and their fixes

All were tidied before the manual test (b4e61a6, b6d337b):

| Rough edge | Fix |
| --- | --- |
| Notices were in English | The core's "no model yet" notice was in Indonesian; the TUI translated eharness notices by their code (`EH_TURN_INTERRUPTED`, `EH_TURN_TIMEOUT`, `EH_CONTEXT_THRASH`, `EH_RUN_FAILED`). (Superseded by P7: all texts are English.) |
| A test login overwrote `~/.keith/client.json` | `KEITH_CLIENT_CONFIG` (through `apps/tui/src/platform/config.ts`; zod is allowed only in that file by check-imports) |
| The eval wrote to the repo's `data/evals`; temp folders were left behind | The default is `<KEITH_DATA_DIR>/evals`; a scripted run no longer creates a temp folder |
| `/health` version `0.0.0` | Changesets: all packages 0.1.0 with a CHANGELOG; the version is read from `apps/core/package.json` |
| Ctrl+C ended a turn silently (proven by a test: no notice, no `/continue`) | `close()` marks the running turn as interrupted with a notice; the core logs `stopping (SIGINT)` and `stopped` (`graceful-stop.e2e.test.ts`) |
| A node without `--allow-shell`: the approval showed first, then the node refused (proven by a test) | `tool.approve` rejects immediately with a clear message when the registry says shell is off; `execute` refuses too as a fallback |
| A 0.01 USD budget said "limit reached" although nothing had been used | The text distinguishes "limit reached" from "the remainder is not enough for one turn (0.5 USD reserve)" |

Evidence: `bun run check` (560 tests; one `0.0.0` version test was adjusted and passes, the other stages green),
`bun run smoke` PASS. The testing guide was updated for this new behavior.

Not yet tested: a real SIGINT/SIGTERM signal to the core process (the test uses `core.close()`). Scenario 5
of the testing guide checks it.
