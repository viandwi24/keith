# UI blocks v1

Standard, renderer-agnostic UI descriptions. Zod schemas live in `@keith/protocol` (`UiBlock`). Model and rules: [architecture/ui.md](../architecture/ui.md). The schema test parses every ` ```json block` example.

## Common fields

Every block has `type` and `id` (unique within the message, `[a-z0-9_-]{1,64}`). Text fields are plain text unless the type says markdown.

## Standard blocks (`ui.render@1` must render all)

| type | fields |
|---|---|
| `markdown` | `text` (CommonMark, no raw HTML) |
| `card` | `title`, `subtitle?`, `body?` (markdown), `image?` (`{ url, alt }`), `footer?`, `children?: UiBlock[]` |
| `list` | `items: { title, subtitle?, meta? }[]`, `ordered?: boolean` |
| `table` | `columns: { key, label, align?: 'left' \| 'right' \| 'center' }[]`, `rows: Record<string, string \| number>[]` (≤ 200 rows) |
| `keyValue` | `pairs: { key, value }[]` |
| `image` | `url`, `alt`, `width?`, `height?` |
| `actions` | `actions: { id, label, style?: 'primary' \| 'secondary' \| 'danger', value?: unknown }[]` |
| `stack` | `direction: 'vertical' \| 'horizontal'`, `children: UiBlock[]` (depth ≤ 4) |

## Optional block: `html`

Part of the `UiBlock` schema, but **not** in the must-render set. Web-based renderers render it. Others show the fallback text.

| type | fields |
|---|---|
| `html` | `html` (a full document, rendered in an iframe with `sandbox="allow-scripts"` and never same-origin), `height?` (px) |

Limits: a serialized block is ≤ 256 KB, nesting depth is ≤ 4, and `url` values are `https:`, `data:image/*`, or core-relative `/v1/files/…`.

## Examples

```json block
{ "type": "card", "id": "weather", "title": "Surabaya", "subtitle": "Now",
  "body": "**31°C**, humid. Rain expected around 16:00.",
  "children": [ { "type": "keyValue", "id": "details", "pairs": [ { "key": "Humidity", "value": "78%" }, { "key": "Wind", "value": "12 km/h" } ] } ] }
```

```json block
{ "type": "table", "id": "venues",
  "columns": [ { "key": "name", "label": "Venue" }, { "key": "capacity", "label": "Capacity", "align": "right" } ],
  "rows": [ { "name": "Riverside Hall", "capacity": 4000 }, { "name": "Harbor Center", "capacity": 6500 } ] }
```

```json block
{ "type": "actions", "id": "confirm", "actions": [ { "id": "book", "label": "Book Riverside", "style": "primary" }, { "id": "more", "label": "Show more" } ] }
```

## Fallback text

Every `ui.render` frame carries `fallbackText`: the tool's `ToolResult.fallbackText` if given, otherwise derived from the block (titles, key/value lines, table as rows). Deriving fallback text is a pure function in `@keith/protocol` (`uiBlockToText`), shared by the core and the TUI.
