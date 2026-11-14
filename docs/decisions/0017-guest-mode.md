# 0017. Guest mode: anonymous, incognito, owner-paid

Status: Accepted (2026-11-08), implemented by P17 (2026-11-09). Resolves the "guests are deferred until per-person budget caps exist" note of ADR-0009 (the caps exist now). Plan: docs/plans/done/P17-guest-mode.md.

## Context

Everyone who talks to Keith is a User (a Person with authentication) or, only if the owner enables it, an anonymous Guest. A guest has no account, no password and
no identity. The front agent is wired to durable stores (`eh_messages`, `eh_state`, `eh_locks`, `eh_inbox`, `eh_stream_log`, the `events` feed, per-person memory on disk;
`compose.ts` builds them, `thalamus/app.ts` writes a 120-character preview of every owner message into the feed). Filtering the front agent for guests would leave many
leak paths. eharness gives each agent in-memory message and state adapters by default (`src/agent/sessions.ts`, `storageFor`), and has no ephemeral session option and no
`deleteSession`. The owner pays for guest turns, so cost is an attack surface.

## Decision

1. **Off by default.** The owner turns guests on and sets: where they can reach (zones; default `lan`), limits and a kill switch. Changes are owner-only, step-up, audited.
2. **A separate port.** Guests are served by a second listener restricted to `/guest/*` and `/health`; the owner API is never widened for them. `public` as a zone is refused
   unless the public URL is `https:` (TLS precondition, ADR-0014). A loopback peer carrying forwarding or Funnel headers counts as `public`.
3. **Incognito by construction.** Each guest session is a tiny separate agent on eharness' default memory storage: no inbox, no stream log, no activity feed, no memory, no
   lock, no compaction. The host owns an in-memory registry and a TTL sweeper; ending a session closes the agent and drops the reference. Core restart ends all sessions.
4. **Read-only first.** A guest can only use operations marked `audience: 'public'` (ADR-0016) on resources readable by `@public` (ADR-0015, guest ceiling: no write). No
   shell, motor, nodes, subagents, memory, tasks, scheduling or web tools. Any approval raised in a guest session is auto-denied and never reaches the owner's attention list.
   A later write path is an append-only, quarantined drop box that the owner's agent never reads as trusted context.
5. **Cheap, priced model.** A new model role `guest`. Guests stay disabled until the owner picks one; an unpriced model is refused (the ledger would be blind).
6. **Defaults:** 0.50 USD per day, 5 USD per month, 3 concurrent sessions, 20 turns per session, 5 session starts per IP per 10 minutes, small step and output caps.
   Entry is refused when the owner's own monthly budget has under 25 percent left, or when any budget scope has no limit.
7. **What is recorded** (abuse and cost only): budget ledger rows (amounts, scope names, random keys) and one aggregate audit row per session
   (`guest.session.end`: random guest id, zone, HMAC of the IP, client kind, start and end, end reason, counts, tokens, cost, per-tool counts, refusal counts). Never text,
   raw IP, user agent, titles or tool inputs. No transcripts (opt-in later, with a banner).
8. **Owner peek.** The owner may read a live guest session (step-up, audited `guest.peek`); guests are told by a banner. The promise is "not stored", not "the owner cannot see".
9. **The leak test is a gate.** A sentinel string is searched in every SQLite table, the WAL and the data directory after each way a session can end.

## Consequences

- The cost of guests is bounded by caps, not by trust; a daily cap exhausted answers 429 and notifies the owner once per hour (counts only).
- The model provider still receives guest messages and may retain them: the banner says so. Process memory may hold text until overwritten.
- Per-IP limits punish a household behind NAT; the global daily cap is the backstop.
- The ACL carries the privacy of public data: a bug there could expose a private note, so the leak kit runs with a guest actor and the guest tools are an allow-list.
- Dead letters of the front agent fall back to the owner's session (`compose-sessions.ts`); the guest agent has no inbox, so it never produces one. Do not attach it to that hook.
- Revisit for the drop box, transcript opt-in, named invited guests, or if eharness gains `agent.deleteSession` (optional, generic) which would simplify the sweeper.
