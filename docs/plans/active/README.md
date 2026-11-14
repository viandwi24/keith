# Active plans

Plans that are not finished. A finished plan moves to `../done/` with its gate evidence.

| Plan | Topic | ADR | Needs |
| --- | --- | --- | --- |
| [P0](P0-mvp.md) | MVP design and release checklist | | |
| [P22](P22-one-keith-foundations.md) | Roadmap and owners of shared items for P23 to P32 | 0020 to 0027 | |
| [P32](P32-second-review-and-real-environment.md) | Second review round and real-environment checks | 0027 | P23 to P31 |

Order: P14 (done, `../done/P14-auth-adapters-and-login-panel.md`) -> P15 (done, `../done/P15-acl-and-visibility.md`) -> P16 (done, `../done/P16-keith-plugin-layer.md`) -> P17 (done, `../done/P17-guest-mode.md`) -> P18 (done, `../done/P18-plugin-tui-views.md`; P19 home motion, done, `../done/P19-home-motion.md`) -> P20 (done, `../done/P20-tui-polish-round.md`, the polish round after hand testing) -> P21 (done, `../done/P21-flow-review-high-fixes.md`) -> P23 -> P26 -> P24 -> P25 -> P27 -> P28 -> P29 -> P30 (done, `../done/P30-shared-rooms.md`) -> P33 (done, `../done/P33-persona-and-answer-modes.md`) -> P31 (done, `../done/P31-node-drivers-and-sandbox.md`) -> P32 (the order of P22). Each plan lists its open verifications, its eharness impact and an "owner to run" scenario list.
Owner decisions common to the P14 to P18 plans: Keith is a personal assistant for one owner, the owner is root and every owner access to a member's private data is audited,
everyone who talks to Keith is a User or (only if enabled) an anonymous Guest, and migrations are additive with a backup and a dry run on a copy of the real database.
