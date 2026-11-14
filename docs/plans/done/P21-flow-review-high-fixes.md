# P21 — Fix the three High findings of the flow review

Nov 10, 2026 · status: **done Nov 10, 2026** (commits a06041d, bdc7d6b, 84a64b1; `bun run check` passed: 2638 pass, 0 fail)

Source: flow review of 2026-11-09 (`docs/flow-review/2026-11-09-full/`, local only, gitignored). Each finding has a proof test that fails today
(`proof-tests/F-00x.proof.ts`). Decisions: ADR-0021 (workspaces), ADR-0022 (delegation), owner answer OWN-012 (secret key recovery).

## Steps

| Step | Finding | Change | Specs |
| --- | --- | --- | --- |
| 1 | F-001 delegate can take over the owner | People service refuses, for a caller who is not the owner: any secret, unlock, rename, alias or grant change whose target is the owner, `transferOwner`, and grant or revoke on the caller themselves. Same check for RPC, socket and CLI paths. `transferOwner` also requires the target to have a password or PIN (F-013). | people.md, permissions.md |
| 2 | F-002 shared worker workspace | `cortex.general` mounts `workspace/people/<personId>/` of the principal it runs for; the old shared folder moves once to `workspace/keith/legacy-shared/`; the worker prompt says "your own folder". | cortex.md, hippocampus.md |
| 3 | F-003 lost secret key bricks the core | A sealed value that cannot be opened no longer stops `start`, setup, `token recover` or `auth` resets: it is dropped with a warning and an audit row, `doctor` and the provider list show "key needs re-entry", and the owner re-enters provider keys. | providers.md, core-cli.md, auth.md (recovery) |

Step 1 done: proof F-001 passes; `people-guard.test.ts` covers owner, self and transfer refusals plus the F-013 secret requirement (18 tests in modules/people pass, core types clean).

Step 2 done: proof F-002 passes; `cortex.test.ts` covers per-person isolation, no-person and legacy move (22 tests in cortex, hippocampus, memory.e2e pass).

Step 3 done: proof F-003 passes; unreadable keys are skipped (`onUnreadable`), warned, audited as `settings.unreadable`, shown as `needsReentry` in the provider list and `doctor`; tests in `offline.test.ts` and `service.test.ts`.

Each step: the proof test's scenario becomes a regular `*.test.ts` next to the code, the spec changes in the same commit, `bun run check` passes.

## Not in this plan

Medium and Low findings, the succession protocol and the other ADR-0020 to ADR-0026 work: see P22.

## Owner to run

- Grant `people.manage` to a member, sign in as that member, try `keith people passwd <owner>`: refused.
- Ask a member's worker to list its workspace: it sees only its own files.
- Change `KEITH_SECRET_KEY`, run `keith-core start`: it starts, warns that provider keys need re-entry; re-enter one in the TUI.
