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
