# packages/client

The typed client every Keith UI uses: wraps `eharness/client` (chat, activity, attention) and
calls the Keith oRPC contract.

- Imports `@keith/contracts`, never an app.
- Must run in Bun (Ink) and the browser (web UI later).
