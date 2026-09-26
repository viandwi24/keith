# ADR-0003: Modality per message; focus instead of takeover

- **Status:** accepted
- **Date:** 2026-09-25

## Context

Kehai modeled `chat` and `voice` as session protocols, allowed one active session per user, and required explicit takeover to switch devices. That state machine added complexity with no user-visible benefit.

## Decision

- `modality: 'text' | 'audio'` is a property of each message (I-6). A Thread freely mixes both.
- The **focus** of a Thread is the node that sent the latest input. Audio output goes to the focus. Text and UI go to all attached nodes (I-7).
- There are no session protocols, no active/passive sessions, and no takeover API.

## Consequences

- Switching devices is "just talk from the other device" (S-7).
- Shared-device arbitration (a living-room speaker used by several people) becomes a policy layer on top of focus, in the phase where headless shared nodes arrive.
