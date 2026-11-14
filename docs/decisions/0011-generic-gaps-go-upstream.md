# 0011. Generic eharness gaps go upstream

Status: Accepted (2026-11-02)

## Context

ADR-0002 said "no upstream PRs during the MVP": every eharness gap was to be filled in
`packages/eh-ext`. The MVP is done and the rule did not work as written. `eh-ext` is still empty,
and the workarounds live across apps/core and packages/db instead:

- nine storage adapters copied from the eharness team example (~2,000 lines);
- a proxy model so compaction can follow the role model;
- its own session-grant map in `motor/remote.ts`;
- a cast into `state.core.activeTurn` in `resume/resume.ts` and a lock `takeOver` flag;
- person ids parsed out of session ids in hooks (P9).

An audit on 2026-11-02 found these gaps in the eharness team example as well, and in other
agent harnesses' designs. They are not Keith's alone. eharness and
Keith have the same maintainer, so fixing them upstream costs less than carrying them here.

## Decision

- A gap is fixed **in eharness** when its reason holds for apps other than Keith, which is
  eharness' rule of two (eharness ADR-0062). The eharness phase records the reason. Keith's need
  alone is not a reason.
- A Keith-only need stays in Keith. Examples: usernames and owner transfer on people, brain events,
  the hippocampus protocol, the role → capability table. Glue around the public eharness API goes
  in `packages/eh-ext`. Product logic stays in its module.
- Keith still uses eharness **as published**: no `node_modules` patches, no `link:` to a checkout.
  An upstream fix reaches Keith through a release, adopted in one deliberate upgrade commit that
  removes the matching workaround.
- The first batch is eharness plan P62 (`docs/plans/P62-adopter-gaps.md` in the eharness repo):
  - SQLite adapters as a package;
  - `ctx` for every policy option;
  - a durable turn principal;
  - grants by principal;
  - interrupt on close and lock owner.

This supersedes the "no upstream PRs" bullet of ADR-0002. The rest of ADR-0002 stands.

## Consequences

- `packages/db/src/eh/*`, `roleSummarizer`, the motor grant map and the resume cast were deleted
  when Keith moved to the eharness release that ships P62 (0.11.0, plan P11).
- P9's person-from-session-id rule became `ctx.principal`. The session-id parser stays only for
  ids that arrive without a turn (activity feed, brain event stamps, attention routes).
- `STOP_REASONS` and `NOTICE_CODES` came from the same route: eharness 0.12.0 added the pure-constants subpath
  `eharness/codes`, `@keith/client` re-exports it, and the TUI keys its notice texts by those constants.
- An upstream fix can wait on an eharness release, so a Keith milestone that needs one plans for
  that wait or keeps a temporary workaround with a note naming the eharness phase.
- Revisit if eharness and Keith get different maintainers.
