# UI blocks v1

Standard, renderer-agnostic UI descriptions. Zod schemas live in `@keith/protocol` (`UiBlock`). Model and rules: [architecture/ui.md](../architecture/ui.md). The schema test parses every ` ```json block` example.

## Common fields

Every block has `type` and `id` (unique within the message, `[a-z0-9_-]{1,64}`). The schema checks uniqueness within one block tree; the core checks it across a message's blocks. Text fields are plain text unless the type says markdown. Unknown fields are ignored.

## Standard blocks (`ui.render@1` must render all)

| type | fields |
|---|---|
| `markdown` | `text` (CommonMark, no raw HTML) |
| `card` | `title`, `subtitle?`, `body?` (markdown), `image?` (`{ url, alt }`), `footer?`, `children?: UiBlock[]` |
| `list` | `items: { title, subtitle?, meta? }[]`, `ordered?: boolean` |
| `table` | `columns: { key, label, align?: 'left' \| 'right' \| 'center' }[]` (at least one), `rows: Record<string, string \| number>[]` (≤ 200 rows) |
| `keyValue` | `pairs: { key, value }[]` |
| `image` | `url`, `alt`, `width?`, `height?` (positive integers, px) |
| `actions` | `actions: { id, label, style?: 'primary' \| 'secondary' \| 'danger', value?: unknown }[]` (at least one; action `id` uses the block id pattern) |
| `stack` | `direction: 'vertical' \| 'horizontal'`, `children: UiBlock[]` (depth ≤ 4) |

## Optional block: `html`

Part of the `UiBlock` schema, but **not** in the must-render set. Web-based renderers render it. Others show the fallback text.

| type | fields |
|---|---|
| `html` | `html` (a full document, rendered in an iframe with `sandbox="allow-scripts"` and never same-origin), `height?` (px) |

Limits: a serialized block is ≤ 256 KB (UTF-8 bytes of its JSON), nesting depth is ≤ 4 (a top-level block is depth 1, its `children` depth 2), and `url` values are `https:`, `data:image/*`, or core-relative `/v1/files/<id>` (no `..`). The limits apply to each top-level block.

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

Every `ui.render` frame carries `fallbackText`: the tool's `ToolResult.fallbackText` if given, otherwise derived from the block. Deriving fallback text is a pure function in `@keith/protocol` (`uiBlockToText`), shared by the core and the TUI:

| type | text |
|---|---|
| `markdown` | the text as is |
| `card` | `title (subtitle)`, then body, `[image: alt]`, each child, footer, one per line |
| `list` | `- title — subtitle (meta)` per item, or `1.` … when `ordered` |
| `table` | column labels joined by ` \| `, then one line per row |
| `keyValue` | `key: value` per line |
| `image` | `[image: alt]` (`[image]` without alt) |
| `actions` | `[label]` per action, space-separated |
| `stack` | children joined by newlines (`vertical`) or ` · ` (`horizontal`) |
| `html` | `[interactive content]` |
