# 0028. Reminders keep their own scheduler; protocols do not absorb them

Status: Accepted (2026-11-10). Amends ADR-0024 §5 ("reminders become protocols inside"). Decided while building P28 phase 6.

## Context

ADR-0024 §5 planned that the reminders plugin keeps its API but runs as a protocol inside: a `time` trigger with one `notify` or `wake` step, one engine for
everything proactive. P28 built the engine and the host port `k.protocols` (step P28.6.1, commit c5c8528). Starting P28.6.2 showed that the protocol model does
not fit a reminder:

1. **Cross-person reminders.** The authoring rules refuse a step to another person from a person-owned protocol (only a keith-owned protocol may name others), but a reminder
   is written by a creator for a recipient.
2. **Billing.** A protocol `wake` is charged to the recipient and has no `billTo`; a reminder is charged to its creator (P25).
3. **Rate limit.** Reminders allow 20 fires an hour per creator; a protocol has `maxRunsPerDay` (at most 20 a day per protocol, 5 for a member).
4. **Caps.** Every reminder would count toward `protocols.maxPerPerson`; exempting them needs a source column (a migration).
5. **Plugin off.** Protocol timers keep firing while the plugin is disabled, which breaks the catch-up rule of P24.6.3.
6. **Names.** A person could name a protocol `reminders:x` and receive the plugin's run-end callbacks.
7. **Tests.** The fires table and the crash test of P25 write `plg_reminders_fires` directly; the move would rewrite the tests that prove exactly-once.

What ADR-0024 §5 wanted is already true without the move: delivery is exactly once by run id through the delivery service (P25), a reminder that cannot be delivered is
reported to its creator (P25, F-010), and the built-in protocol `reminder-missed` (P28.4.2) runs the retry ladder from the `delivery.failed` record.

## Decision

1. **The reminders plugin keeps its own scheduler and its fires table.** Its API, tools, view and events do not change, and the P25 flow (claim, deliver by fire id, accept) stays the
   one exactly-once path for reminders.
2. **`k.protocols` stays as a host port** (built and tested in P28.6.1) for plugins that want a proactive rule of their own. A plugin protocol is owned by a person, named
   `<plugin>:<key>`, and follows the one authoring function. Before another plugin relies on the plugin-name prefix, `:` is reserved in protocol names that a person types
   (blocker 6 above); the reminders plugin does not use the port.
3. **P28 steps P28.6.2 to P28.6.4 are not built.** The goal of P28.6.4 (a retry ladder for undelivered reminders) is met by the built-in `reminder-missed`.
4. **Revisit** only with a concrete need that the reminders scheduler cannot meet (for example a reminder that needs a condition or an `ask` step), and then as a new ADR
   that settles billing, per-protocol caps and the disabled-plugin behaviour first.

## Consequences

- One less risky migration of a stable, well-tested flow; the engine and the reminders each stay simple.
- Two timers exist (the plugin scheduler and the protocol engine). They share `eh_schedules`, scoped by id prefix (`plugin:` and `protocol:`), and the plugin scheduler ignores
  `protocol:` rows (P28.2.6).
- ADR-0024 §5 is no longer a promise; the unification it described is not planned.
