# Keith

> A self-hosted personal AI that behaves like one continuous mind, not a chat session.

Keith is one awareness that lives on your server. Many people can talk to it at the same time. Each of them gets their own relationship with it, and it stays the same mind underneath. It can work in the background, keep the promises it makes ("I'll tell you when it's done"), and reach you through any surface you connect: a terminal, a browser, a phone, a headless machine.

Think of Jarvis talking to Tony, Pepper and Rhodey at once. It keeps each conversation separate and never stops being Jarvis.

**Status:** pre-alpha, design phase. Nothing here is usable yet.

## Core ideas

- **One Mind.** One identity, one memory, and one attention scheduler per deployment.
- **Many Relationships.** Each person gets a different "face": tone, trust, what they are allowed to see. Context crosses between people only when visibility rules allow it.
- **Threads, not sessions.** A conversation is a Thread. Text and voice are properties of a single message, not modes you switch between.
- **Nodes everywhere.** Every surface is a Node that declares its capabilities: TUI, web, mobile, desktop, or a headless machine exposing its filesystem or microphone.
- **Everything else is a plugin.** Tools, model providers, skills, agents, and client apps that need server-side code (like the web UI).
- **Adapters where choice matters.** Pick cloud, cheap, or local providers for LLMs and voice. OpenRouter and DeepSeek are supported first.

## Stack

- [Bun](https://bun.sh) + TypeScript for the core, plugins and clients.
- Rust for out-of-process system nodes (planned).
- SQLite for storage.

## Documentation

Start at [`docs/README.md`](docs/README.md). AI coding agents should start at [`AGENTS.md`](AGENTS.md).

## License

To be decided before the first public release.
