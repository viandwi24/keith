# Phase 8: Ecosystem (overview)

> Overview only. Lanes are independent and can run whenever their prerequisites are done.

| Lane | Work | Needs |
|---|---|---|
| MCP | MCP client: configured MCP servers → tools in the registry (namespaced), per-server `minTier` | Phase 1 |
| Telegram | `@keith/telegram`: a `client-app` plugin that bridges Telegram chats to Threads (one Telegram user = one Person, linked by invite) | Phase 5 |
| Realtime | `RealtimeProvider` adapters (e.g. Gemini Live, OpenAI Realtime), per-thread realtime mode | Phase 3 |
| Providers | More LLM providers: Anthropic, Gemini, Ollama, LM Studio | Phase 1 |
| Mobile | Mobile app node (framework ADR) | Phase 3 |
