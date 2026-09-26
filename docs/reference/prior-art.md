# Prior art

Systems worth learning from. Read the relevant entry before designing the matching phase. Borrow ideas, not architecture wholesale.

| System | What to learn | Relevant to |
|---|---|---|
| **Kehai** (predecessor) | Commitments as a deterministic notification gate. Memory provenance and visibility. Capability-driven routing. What *not* to do: [lessons.md](../concept/lessons.md) | All |
| [Mark-LIV](https://github.com/FatihMakes/Mark-LIV) | Gemini-Live JARVIS desktop assistant. A memory "core + index of keys + recall tool" pattern, an undo stack for actions, UI-issued confirmation tokens the model can't forge, instant acknowledgment before long work | Memory (P1-M1, phase 4), tools safety |
| [LiveKit Agents](https://github.com/livekit/agents) · [Pipecat](https://github.com/pipecat-ai/pipecat) | Pluggable VAD/STT/LLM/TTS pipelines, turn detection, interruption handling, realtime model plugins | Phase 3 |
| [Letta (MemGPT)](https://github.com/letta-ai/letta) | Core memory vs archival memory, self-editing memory through tools | Phase 4 |
| [MCP](https://modelcontextprotocol.io) and MCP Apps | Tool servers out of process. UI resources rendered in sandboxed iframes by any host | Phase 2 (UI), phase 8 |
| Google A2UI | Declarative, renderer-agnostic agent UI | Phase 2, phase 6 |
| [Open Interpreter 01](https://github.com/OpenInterpreter/01) | A device ↔ server protocol for a voice-first assistant | Phase 3, 7 |
| OpenClaw | Gateway + nodes + multi-channel personal agent | Phases 5, 7, 8 |
| [Agent S](https://github.com/simular-ai/Agent-S) · [Bytebot](https://github.com/bytebot-ai/bytebot) · UI-TARS | Computer-use agents: screen → action loops | Phase 7+ |
| Linux display servers / desktop environments | The analogy for client-app plugins: apps speak a protocol, and the DE is optional | [ADR-0002](../decisions/0002-plugins-run-in-core-nodes-do-not.md) |

Verify the current state of any external project before depending on it. This list was compiled on 2026-09-25.
