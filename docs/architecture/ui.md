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
- **Validation at the core.** A tool returning an invalid block has its `ui` dropped, gets a logged warning, and the turn goes on.

## Tiers of UI

1. **Standard blocks** (guaranteed): `markdown`, `card`, `list`, `table`, `keyValue`, `image`, `actions`, `stack`. Any node claiming `ui.render@1` must render all of them.
2. **Sandboxed HTML** (the optional `html` block): an HTML document rendered in an iframe with `sandbox="allow-scripts"` and no same-origin. This is the escape hatch for rich, custom visuals. Any web-based renderer can support it. Non-web renderers show the fallback.
3. **Custom block types** (phase 6+): a plugin may define `type: "x-<plugin>-<name>"` with its own schema and ship a renderer module for a specific client app. It must always include a standard-block `fallback`. Needs an ADR for the renderer-loading mechanism before it is built.

## Interactivity

`actions` blocks carry buttons. A click sends `ui.action { threadId, messageId, blockId, actionId, value }` from the node. The core looks up the block in the message's persisted `ui` entries (which record the originating tool, see [storage.md](storage.md#messages-and-tool-calls)) and turns the click into:
- a call to that tool's `onAction` handler if it declared one, or
- a user input "(clicked: <label>)" into the Thread otherwise.

## Rendering rules for client apps

- Keep one visual language: in the web app, blocks render with the same shadcn/ui components and theme tokens as the rest of the UI.
- Blocks attach to the assistant message they belong to (`messageId`), or float in the Thread if they have none.
- Images use URLs served by the core (`/v1/files/:id`, phase 2) or `data:` URIs under 256 KB.
