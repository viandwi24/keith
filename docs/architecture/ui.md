# UI: how plugins show things

Contract: [contracts/ui-blocks.md](../contracts/ui-blocks.md).

## The problem this solves

A weather tool wants to show a card. If it had to target the web plugin, it would depend on web, and web would become a special node again (Kehai's mistake, [L-6](../concept/lessons.md)). Instead:

```
tool plugin ──returns── { content: "22°C, rain at 4pm", ui: UiBlock }
                                   │                        │
                        model sees this              core validates against the
                                                     UI block schema, then sends
                                                     ui.render to nodes with ui.render@1
                                                             │
                                  ┌──────────────────────────┼──────────────────────┐
                            web renders a card        TUI (no ui.render) shows    future mobile
                                                      the message text only       renders natively
```

- **The core owns the schema.** It lives in `@keith/protocol`. Tool plugins produce blocks, client apps render them, and neither knows about the other (I-9).
- **Every `ui.render` frame carries `fallbackText`.** A node that can't render a block type shows the fallback. Nothing is ever invisible.
- **Validation at the core.** A tool returning an invalid block has its `ui` dropped, gets a logged warning, and the turn goes on. The run loop checks each block against the `UiBlock` schema and its limits (depth, size, URL schemes, ids unique in the tree; `mind/ui.ts`), and the ThreadManager drops a block that reuses a block id already on the same message, so a `ui.action` always names one block.

## Tiers of UI

1. **Standard blocks** (guaranteed): `markdown`, `card`, `list`, `table`, `keyValue`, `image`, `actions`, `stack`. Any node claiming `ui.render@1` must render all of them.
2. **Sandboxed HTML** (the optional `html` block): an HTML document rendered in an iframe with `sandbox="allow-scripts"` and no same-origin. This is the escape hatch for rich, custom visuals. Any web-based renderer can support it. Non-web renderers show the fallback.
3. **Custom block types** (phase 6+): a plugin may define `type: "x-<plugin>-<name>"` with its own schema and ship a renderer module for a specific client app. It must always include a standard-block `fallback`. Needs an ADR for the renderer-loading mechanism before it is built.

## Interactivity

`actions` blocks carry buttons. A click sends `ui.action { threadId, messageId, blockId, actionId, value }` from the node. The core looks up the block in the message's persisted `ui` entries (which record the originating tool, see [storage.md](storage.md#messages-and-tool-calls)) and turns the click into:
- a call to that tool's `onAction` handler if it declared one, or
- a user input "(clicked: <label>)" into the Thread otherwise.

How the core handles it (`server/connection.ts` → `ThreadManager.action` in `mind/thread-manager.ts`):

| Step | Rule |
|---|---|
| Routing | The server accepts `ui.action` only for a thread open on that node (else `error { FORBIDDEN }`), and does not wait for the result, so `input.cancel` still gets through. A rejection becomes an `error` frame with `re` set to the action's frame id: `NOT_FOUND`, `FORBIDDEN` as is, anything else `INTERNAL` |
| Lookup | The message must be an assistant message of that thread, `blockId` an `actions` block at any depth of one of its `ui` entries, and `actionId` one of its actions. Otherwise `NOT_FOUND` |
| Who may click | Only a current participant of the thread (`FORBIDDEN`). Before `onAction` runs, the tool's `minTier` is checked against the lowest tier of the clicking person and the thread's participants, who all see the result (R-14). Refused → `FORBIDDEN`, and `onAction` is not called |
| `onAction` | Called once, with `ToolAction { messageId, blockId, actionId, value }` and a `ToolRunContext` whose `person` is the clicking person, `participants` the thread's, `taskId` null. `value` is the frame's `value`, or the action's stored `value` when the frame has none. The tool's `timeoutMs` applies (`TOOL_TIMEOUT` → `INTERNAL` frame) |
| Result | A returned `ToolResult` becomes an assistant message without a model call: `message.started` (`proactive: false`), `ui.render` of its validated block to `ui.render@1` nodes, then `message.completed`. The block is stored with the same tool name, so clicks on it reach the same handler. It is appended after any running turn, so history stays ordered. `undefined` adds nothing |
| No handler | When the tool has no `onAction`, or is no longer registered, the click is the input `(clicked: <label>)` from the clicking person and node. The `message.user` echo also goes to the clicking node, which never typed the text |

## Rendering rules for client apps

- Keep one visual language: in the web app, blocks render with the same shadcn/ui components and theme tokens as the rest of the UI.
- Blocks attach to the assistant message they belong to (`messageId`), or float in the Thread if they have none.
- Images use URLs served by the core (`/v1/files/:id`, phase 2) or `data:` URIs under 256 KB. `/v1/files/:id` needs the bearer token (see [storage.md](storage.md#files)), so a browser fetches the bytes with an `Authorization` header and shows them from an object URL; a plain `<img src>` gets `401`.
- History carries blocks too: `MessageDto.ui` holds a reply's blocks in `thread.opened`, `message.completed` and `GET /v1/threads/:id/messages`, so a client renders the same blocks after a reload as it did live.

## The web app

The browser half of `@keith/web` (`plugins/web/app/`, a Node per [ADR-0011](../decisions/0011-client-app-browser-side.md)) renders blocks with React and the same shadcn/ui components and theme tokens as the rest of its UI. It is built with Bun's HTML bundler ([ADR-0012](../decisions/0012-web-bundler.md)) into `plugins/web/dist/` (`bun run --cwd plugins/web build`). The core serves that folder at `/` with an SPA fallback when `@keith/web` is enabled; `/v1` keeps answering as the API, and without a build a placeholder page is served instead.

| Block | Renders as (`components/blocks/ui-block.tsx`) |
|---|---|
| `markdown` | `react-markdown` (CommonMark). Raw HTML is skipped, links keep only `http(s):`/`mailto:` and open in a new tab, markdown images are not loaded (their alt text shows) |
| `card` | shadcn `Card`: image on top, title, subtitle, markdown body, children, footer |
| `list` | a bordered list, numbered when `ordered`, with subtitle and meta |
| `table` | shadcn `Table`, cells aligned per column |
| `keyValue` | a `<dl>` grid |
| `image` | `<img>`: `https:` and `data:image/*` directly; `/v1/files/<id>` fetched with `Authorization: Bearer` and shown from an object URL (revoked on unmount); anything else, or a failed fetch, shows `[image: alt]` |
| `actions` | shadcn `Button`s (`primary` → default, `secondary` → outline, `danger` → destructive). A click sends `ui.action` with the message id, block id, action id and the action's `value` if it has one. Buttons of a floating block (no `messageId`) are disabled, since `ui.action` needs a message |
| `stack` | a flex row (wrapping) or column |
| `html` | `<iframe sandbox="allow-scripts" srcdoc=…>` (never `allow-same-origin`), `height` px or 240 |
| unknown type | the entry's `fallbackText` |

Other rendering rules:
- The app declares `chat.text@1` and `ui.render@1` in `hello` and keeps its session (token, `nodeId`) in `localStorage` through `@keith/client`'s `webStorageSessionStore`.
- Blocks attach below their assistant message; floating blocks sit in the timeline where they arrived.
- Assistant rows with no text, no blocks and no streaming (tool steps in `GET /v1/threads/:id/messages`) are not shown (`isHiddenEntry` in `@keith/client`, shared with the TUI).
- Proactive messages carry a badge; tool activity shows as one line per tool call; the turn state shows above the input, with a Cancel button while a turn runs.
- A lost connection shows a banner with the retry countdown and "Retry now". A rejected token (close `4003`) shows a sign-in form, then reconnects with the new token and keeps the thread.
- shadcn/ui components live in `plugins/web/app/components/ui/` and are added with `bunx --bun shadcn@latest add <name>` run from `plugins/web/app/`, which holds `components.json` and a small `package.json` (name `@keith/web-app`, only the `#components/*`, `#lib/*`, `#hooks/*` import aliases the CLI needs). The CLI also installs the component's npm dependencies there: add them to `plugins/web/package.json` with `bun add` instead, and delete `app/node_modules` and `app/bun.lock` (both are gitignored).

## Nodes without `ui.render@1` (the TUI)

The TUI declares only `chat.text@1`, so it gets no `ui.render` frames: it shows the message text, which the tool's `content` or the model's reply already carries. When a history message has blocks but no text, it shows the blocks' fallback (`uiBlockToText`, the same text the core puts in `ui.render.fallbackText` when a tool gives none). It skips the same empty tool-step rows as the web app.

## Enabling the web app (S-8)

`keith setup` offers `@keith/web` and `@keith/tool-weather` (both enabled, neither required). On an existing `config.toml` it prints how to add whichever is missing to `plugins.enabled`. Nothing else changes: the Mind and the tool plugins never know which nodes render blocks (I-9, I-12). `tests/e2e/s8-web.test.ts` plays the scenario in Chromium with Playwright against the built app.
