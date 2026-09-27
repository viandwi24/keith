# Phase 3: Voice

**Goal:** speak to Keith from the browser and hear it answer. Switching device or modality mid-conversation just works (S-7, I-6, I-7). See [voice.md](../../architecture/voice.md) and [ADR-0013](../../decisions/0013-voice-v1-transport-and-providers.md).

| Wave | Task | Lane | Owns (summary) |
|---|---|---|---|
| 1 | [P3-K1 Contract additions and core voice interfaces](P3-K1-contracts.md) | K | contracts, protocol, sdk provider types, `voice/types.ts`, `mind/`/`server/`/`storage/` types, config |
| 2 | [P3-A1 Core voice pipeline](P3-A1-voice-pipeline.md) | A | `core/src/voice` |
| 2 | [P3-A2 Audio frames, listening, barge-in](P3-A2-mind-server-voice.md) | A | `core/src/{mind,server}` |
| 2 | [P3-B1 Audio helpers + Groq/OpenAI/speaches plugins](P3-B1-audio-adapters.md) | B | `sdk/src/providers/openai-audio*`, `plugins/voice-*` |
| 2 | [P3-D1 `@keith/vad-energy`](P3-D1-vad-energy.md) | D | `plugins/vad-energy` |
| 2 | [P3-E1 Browser voice](P3-E1-web-voice.md) | E | `packages/client`, `plugins/web/app` |
| 3 | [P3-I1 Integration: bootstrap, setup, config](P3-I1-integration.md) | I | fixes, bootstrap, setup |
| 4 | [P3-I2 S-7 end to end](P3-I2-e2e.md) | I | `tests/e2e`, fixes |

The overview's lanes B (STT) and C (TTS) merged into P3-B1, because one OpenAI-compatible helper pair serves every v1 adapter (ADR-0013).

**Reserved ADR numbers:** 0013 for P3-K1 (voice v1 transport and providers). Lane agents start at 0014.

**Exit:** S-7 passes in CI with synthetic audio, and a human spoke to Keith in a browser with real providers.

## Hardening (after the phase 0–3 audit)

The coordinator's audit found gaps across phases 0–3: [hardening-audit.md](hardening-audit.md). The owner chose to close all of them in phase 3.

| Wave | Task | Owns (summary) |
|---|---|---|
| 5 | [P3-K2 Contract clarifications and interfaces](P3-K2-contracts-hardening.md) | contracts, `*/types.ts`, config |
| 6 | [P3-H1 Mind fixes](P3-H1-mind-fixes.md) | `core/src/mind`, `plugins/tools.ts` |
| 6 | [P3-H2 Server fixes](P3-H2-server-fixes.md) | `core/src/server` |
| 6 | [P3-H3 Message seq, deliveries.message_id](P3-H3-storage-seq.md) | `core/src/storage`, `core/drizzle` |
| 6 | [P3-H4 Home lock, log files](P3-H4-ops-lock-logs.md) | `core/src/shared/{logger,lock,log-file}`, `core/src/cli` |
| 6 | [P3-H5 Sync and deps checks](P3-H5-scripts-checks.md) | `scripts` |
| 6 | [P3-H6 TUI logout, scrollback](P3-H6-tui-logout-scrollback.md) | `apps/tui` |
| 7 | [P3-H7 Delivery UI, order by seq](P3-H7-delivery-ui.md) | `core/src/{mind,scheduler}` |
| 8 | [P3-I3 Hardening integration](P3-I3-hardening-integration.md) | wiring, e2e, docs |

## Exit (2026-09-27)

Closed by the owner's decision with two items still open:

- [x] Integration tasks done (P3-I1, P3-I2, P3-I3); S-7 and S-8 pass locally 5 runs in a row, and `bun run check` is green.
- [ ] **CI:** the e2e tests have not run in CI yet. The owner pushes `main` manually.
- [ ] **Human run with real keys:** deferred by the owner. The steps are in [P3-I2](P3-I2-e2e.md#human-run-owner-real-keys). The same goes for the human runs of P1-I1, P1-I2 and P2-I1, re-recording the synthetic provider fixtures, and tuning the energy VAD with a real mic ([hardening-audit.md](hardening-audit.md#manual-owner)).
- [x] No `> Planned (phase 3)` markers left in `docs/architecture`.
- [x] Phase-4 task files written ([phase-4-memory/](../phase-4-memory/README.md)).
