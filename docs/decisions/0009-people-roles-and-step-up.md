# 0009. People, roles, capabilities and step-up

Status: Accepted (2026-10-28). Amended by ADR-0014 (a PIN starts an assurance-1 session; rotation opt-in), ADR-0017 (guests exist), ADR-0022 (delegation is not succession) and ADR-0027 §6 (`audit.read` is owner only)

## Context

ADR-0008 left one person, the owner, behind a socket and credentials. P9 adds members who sign in from
their own clients, which raises four questions: what models a person, who may do what, how a sensitive
action from a remote client is confirmed, and how people stay apart.

## Decision

- **Identity is `eharness/identity`.** `Person`, `PersonAccount` and `PersonEvent` are the model; a
  SQLite `PersonStore` in packages/db passes the eharness conformance suite. New ids are UUIDv7, the owner
  keeps `owner`, usernames are a separate unique field, session ids are `front:<personId>`. Exactly one
  owner; transfer is one transaction that revokes both people's sessions. Guests are deferred. Superseded: ADR-0017 decided guest mode (implemented by P17, Nov 9, 2026).
- **Capabilities, one middleware.** Each oRPC procedure declares a capability from a closed set
  (`packages/contracts`); a role table plus per-person grants gives a principal its set; one middleware
  checks it, and a test fails when a procedure has none. Non-oRPC routes (`/sessions`, `/attention`,
  `/activity`) check the same capabilities and a person's own session.
- **Step-up, not re-login.** Sensitive capabilities need a recent confirmation from a remote client:
  `POST /auth/step-up` with a PIN or the password, a fixed 10-minute `elevated_until` on the credential
  (no rotation, so streams survive). The local socket is always elevated; a legacy token never is. Answers
  `KEITH_STEP_UP_REQUIRED` on `/rpc` and `/attention` only, and the TUI prompts and retries once.
- **Passwords and PINs.** argon2id with pinned cost, 2 concurrent hashes, 15-character minimum and no
  composition rules, a PIN that never starts a session, uniform failures, throttling per (account, IP)
  with a persisted counter, a member lock after 20 failures, and a network rule (loopback, Tailscale,
  `tailscale serve`; never Funnel or unknown proxies) for the two routes. `KEITH_INSECURE_LOGIN` lifts it.
- **Owner-routed approvals.** A member's `shell.exec` is an approval only the owner answers (a member
  gets `KEITH_WAITING_FOR_OWNER`), shown with asker, node and command, and answering it remotely needs a
  step-up. `tool.approve` stays deterministic (input and static tables only); the person comes from the
  root session id, never from runtime state.
- **Isolation.** No hardcoded `front:owner`: recovery, reconcile, dead letters and graceful stop
  enumerate people; memory is `memory/<personId>/` (agent path `/memories/<personId>`); the activity feed
  and `/attention` are filtered per person; the budget keeps one global limit plus per-person caps and the
  ledger records the person. Removing a person deletes credentials, not conversations or memory.

## Consequences

- A member cannot read the owner's memory, activity, settings or sessions, and cannot spend past a cap.
- Behind `tailscale serve` all callers share one address for throttling (SECURITY.md).
- Same-user socket risk from ADR-0008 stays: the socket is the owner and never asks for a PIN.
- A new capability or procedure is one table line plus metadata; forgetting it fails the test.
- Revisit for guests, a web UI (idle lock, TLS) and retention or export of a removed person's data.
