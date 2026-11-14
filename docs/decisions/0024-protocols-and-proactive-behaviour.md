# 0024. Protocols: one engine for proactive behaviour (hypothalamus)

Status: Accepted (2026-11-10), design; build in P25 (delivery service, §5) and P28 (protocol engine). Amended by ADR-0028 (§5: reminders keep their own scheduler, not built) and by ADR-0027 §10: expiry of an approval is the amygdala sweeper (P24); the `approval-stale` protocol only pings. New region `hypothalamus` (ADR-0004). Uses ADR-0025 (presence) for signals and ADR-0022
for the first built-in protocol.

## Context

A real assistant acts before it is asked: it checks in when the owner is silent for a day, starts the owner-absence protocol after 14 days, notices
that "meeting at 9" means "do not disturb at 9", and follows standing orders such as "if the house alarm fires and I do not answer, call Duta".
Today Keith has reminders (a plugin with a scheduler), wake turns (RAS) and approvals, but no common place for rules. Many rules will come; each
must be safe, cheap and auditable, and must not depend on a model remembering a promise.

## Decision

1. **A protocol** is data, stored per owner of the protocol:
   `id, owner (a person or keith), trigger, conditions, steps, limits, enabled, version`.
   - **Trigger**: `time` (cron or once), `absence` (no sign of life from a person for a duration), `signal` (a presence or node event matching a
     filter), `event` (a brain event such as `brain.amygdala.wait` older than N minutes).
   - **Conditions**: pure checks on presence, time of day, agenda and budget, evaluated in code.
   - **Steps**: an escalation ladder. Each step is one of `notify` (a message to a person on their best channel), `ask` (a question that waits
     for an answer with a timeout), `wake` (a model turn with a fixed instruction), `act` (a named operation or capability with fixed input),
     `wait` (a duration). A step can branch on the answer or the timeout.
   - **Limits**: max runs per day, budget per run, quiet hours.
2. **The engine is deterministic; the model is a step, not the scheduler.** Triggers and conditions are code. A model turn happens only in a
   `wake` step and runs as the protocol owner's principal (ADR-0020). Protocol state (`run`, current step, answers, deadlines) is stored in
   SQLite and survives restarts; every step writes a `protocol.*` audit row and a `brain.hypothalamus.*` event.
3. **Who may author what.**
   - Anyone may create protocols for themselves with `notify`, `ask`, `wake` and `wait` (a personal reminder ladder).
   - `act` steps that touch nodes, other people or Keith's self layer are owner only, and each `act` names an operation that the owner approved
     when saving the protocol (pre-approval, recorded with the exact input). A protocol never widens access or changes ownership except the
     built-in succession protocol (ADR-0022).
   - Keith may **propose** a protocol from a conversation ("you said meeting at 9; shall I keep 9 to 10 quiet?"); it is saved only after the
     person confirms.
4. **Built-in protocols** ship disabled or with safe defaults: `owner-absence` (ADR-0022), `approval-stale` (a pending approval older than N
   hours pings the owner, then expires the request; closes F-009), `reminder-missed` (a reminder that could not be delivered is retried and then
   reported; closes F-010).
5. **Reminders become protocols later.** The reminders plugin keeps its API; inside, a reminder is a `time` trigger with one `notify` or `wake`
   step. Delivery goes through one delivery service (exactly-once by run id, closes F-019/F-020).

## Consequences

- Proactivity is visible and controllable: the owner can list, pause and audit every rule; nothing proactive hides in a prompt.
- One delivery path and one durable state machine replace ad hoc timers.
- Work: a store, an engine loop, an authoring UI in the TUI (`Apps > Protocols`), and agent tools to propose protocols.
- Revisit when protocols need to coordinate several people at once (rooms, ADR-0026) or run on a node while the core is down.
