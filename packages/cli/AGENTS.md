# packages/cli

Shared CLI toolkit for `keith-core`, `keith-node` and `keith`: prompts, command registry and help, output helpers. Contract: docs/specs/cli.md.

- No third-party dependencies: `node:util` `parseArgs`, raw mode, plain ANSI.
- Every prompt and the runner take an injectable io; tests never need a real terminal.
