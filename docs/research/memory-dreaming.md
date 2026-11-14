# Memory dreaming: patterns for offline memory consolidation

Status: research, input to the dreaming design. Not a spec and not a decision. Written Nov 11, 2026.
Keith's current memory contract: `docs/specs/hippocampus.md`. Proactive work: `docs/specs/hypothalamus.md`
(protocols, engine, audit, budget owner).

This study is product-neutral. It describes the patterns that recur in agent systems that consolidate
memory outside the conversation, and the trade-offs of each. It names no product and links no source.

## Summary

- Offline consolidation systems are usually three parts stacked: a short-term signal store (recall hits,
  session transcripts, recent events), an offline pass that scores and rewrites, and a durable store the
  agent reads at the next session. Only some of them delete anything.
- The safest designs never destroy a fact in place. They invalidate it with a timestamp, keep a
  preimage of the file before each change, and reject a rewrite that drops too many prior entries.
  Versioned or git-backed memory files give the same safety at the storage layer.
- Triggers are cheap and boring: a fixed time of day, a step or message count, a context compaction,
  or a threshold on an importance sum over recent events.
- Human review is offered as an option, not the default, in the systems that have it: a setting that
  holds writes for approval before they reach the store, off by default.
- For Keith the strongest reusable parts are: staged output with a preimage, an append-only fallback,
  invalidate-not-delete for contradictions, the entry-loss guard, and the existing hypothalamus
  protocol engine for scheduling. The parts Keith cannot take as they are: a memory shared across
  agents or people, and any consolidator that writes without a per-person principal.

## Patterns observed

**Two stores, one promotion path.** Short-term signals (recall hits, transcripts, events) are kept apart
from durable notes. Promotion is explicit, scored, and rate-limited. Systems that rank candidates by
recall frequency, recency and query diversity all put a minimum threshold in front of promotion.

**Stage, then apply.** Output lands in a diary or a proposal first. A narrative diary written for humans
is not a source of truth. Systems with a review step hold the proposal until the owner accepts it.

**Invalidate, do not delete.** A superseded fact stays in the history with a validity window or a
"superseded" mark. The systems that delete outright have no preimage, so an error becomes permanent and
invisible to the owner.

**Preimage before every change.** The previous content of a file is saved before the pass rewrites it.
Undo then means restoring the saved text for one run. Undo granularity varies: per run, or per file
edit.

**Guard against rewrites that lose too much.** One system rejects a rewrite that drops more than a
quarter of the prior entries of a file, or that drops a source reference. It then falls back to an
append-only path for that file. Other systems rely on the model to keep what matters.

**Scheduling.** A fixed daily time, step or message counts, and compaction are the common triggers.
Idle-based triggers were not found in the sources read.

**Provenance filters before the model.** Candidates whose origin is untrusted (fetched pages, tool output,
system text) are removed before the prompt. This is a structural gate, not a score. Read-only workers
follow the same rule.

**Session history is not the store.** Raw history can sit in a searchable store that the agent queries on
demand. The durable notes are a separate, small file.

**Model-scored importance.** An importance score from 1 to 10, given when a memory is created, can rank
candidates and trigger a reflection once a sum passes a threshold. The reflections keep pointers to the
records behind them, so each one can be traced to its evidence. Nothing is deleted.

**Shared memory versus per-person memory.** Some systems let several agents read and write the same
memory blocks, so one agent's offline pass changes what another agent reads. This is the opposite of
per-person isolation.

**Unverified claims.** Several public descriptions name thresholds (for example, "every 10 turns", a
"24 hours and 5 sessions" gate) that were not confirmed in official material. They are not used here.

## What Keith should take

- **Preimage before every change, kept in the core DB.** Undo is then "restore the preimage for this
  run", and the owner can list runs. Map it to the audit log (`audit` tables) and the
  `brain.hippocampus.write` event with a `dreamRunId`.
- **Entry-loss guard.** Reject a consolidated `profile.md` or memory file that drops more than a set
  fraction of prior lines or loses a `Source:` reference; fall back to append-only. Fits the 2000-char
  `profile.md` limit.
- **Invalidate instead of delete for contradictions.** Keep the old line as a dated, struck entry in a
  per-person `history/` file (outside the pinned profile), so the front agent reads the current fact and
  the owner can see the change.
- **Two-tier store.** Recall or session signals in SQLite (not in the person's folder), durable notes in
  `/memories/<personId>`. Nothing in the signals store is pinned or shown to the model directly.
- **Scheduling through hypothalamus.** A protocol with a time trigger (per person's timezone) or a
  turn-count trigger, budget billed to the protocol owner, every step audited. Idle detection can read
  parietal presence (`idle`, `away`) instead of a new timer.
- **Review option per person.** An "update automatically or review first" choice, and a write-approval
  setting, show that the choice belongs to the owner. Default to review for profile changes.
- **Provenance gate.** Only front-session turns and the person's own messages feed the consolidator;
  worker reports and fetched pages are excluded (the same rule as the read-only workers).

## What Keith should not take

- **Shared memory across agents or people.** It breaks "one principal per turn" and "one person's agents
  never read another's folder" (`docs/specs/hippocampus.md`, Invariants).
- **A consolidator that writes with no principal, or with the owner's principal.** A pass must run as the
  folder's person, with the `/memories/<personId>` root only. Its tools must not see the workspace,
  other rooms, or other people's sessions.
- **Silent deletion.** An LLM-chosen `DELETE` with no preimage. Keith's rule "the owner can audit and
  undo" needs the old text kept.
- **Auto-promotion of unreviewed facts into `profile.md`.** The pinned file goes into every turn; a
  mistaken fact would shape every answer. Keep a review step, as the approval gate does.
- **Importance scores from the model as the only filter.** Keith can use a score for ranking, but the
  apply step needs rules a person can read.
- **Consolidation of secrets or credentials.** Secret guard still applies to any write, and a pass must
  not read `.env`-like content at all (none is in memory, but the rule must stay).
- **Unverified thresholds.** Do not copy numbers from secondary write-ups that were not confirmed in
  official material.

## Open questions

1. **Writer rule.** `docs/specs/hippocampus.md` says only the front agent writes memory. A consolidator
   needs an ADR amendment: either the front role runs the pass as a protocol step, or a second writer
   with the same root and secret guard. Which one?
2. **Where do signals live?** Recall events exist (`brain.hippocampus.recall`), but no store holds them
   yet. Is a new table in `packages/db` enough, and does it need a retention limit?
3. **Trigger shape.** A nightly protocol per person, a turn-count protocol, or both? Which timezone is
   used when a person has no set zone?
4. **Undo granularity.** Preimage per run or per file edit? How long is the preimage kept, and is it
   inside the `workspace/keith/removed` style retention (30 days)?
5. **Contradictions in `profile.md`.** Invalidate the line into a history file, or ask the person first?
6. **Cost.** Who pays for a pass a person did not ask for? The hypothalamus rule bills the protocol
   owner; for a member's own pass, is that the member or the owner?
7. **Verification.** Before any design depends on a claim about another system's operations, conflict
   rules or thresholds, the claim needs a primary source: its official docs, its code, or the paper.
8. **Not surveyed:** user-modelling layers and curator-style background agents. Study them if the design
   needs a user-model layer.
