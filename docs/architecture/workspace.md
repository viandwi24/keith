# Workspace

> Planned (phase 6). This doc fixes the concept so earlier phases leave room for it.

## Concept

The workspace is the Mind's **visual space**: a set of windows it arranges to show things, like Jarvis putting the morning news, a map and a status board on Tony's screens.

- The workspace is **state owned by the core**. Client apps only render it (I-9).
- There is one workspace per Person (their direct context) and one per group Thread (shared, S-6).
- The Mind changes it with tools. Humans can change it too (move, close, scroll), and those changes flow back as events, so the Mind knows what is on screen.

## State shape (draft)

```ts
interface WorkspaceState {
  version: number                         // increments on every change; nodes ignore stale patches
  windows: Array<{
    id: `win_${string}`
    title: string
    group?: string                        // windows in the same group are laid out together
    layout: { x: number; y: number; w: number; h: number }   // grid units, 12-column
    content:
      | { kind: 'blocks'; blocks: UiBlock[] }                 // standard UI blocks
      | { kind: 'html'; html: string }                        // sandboxed
      | { kind: 'url'; url: string }                          // iframe; may be blocked by the site
      | { kind: 'stream'; streamId: string }                  // screen share or camera (needs a transport ADR)
    scroll?: number
    focused?: boolean
  }>
}
```

## Tools (draft)

`workspace.open`, `workspace.update`, `workspace.close`, `workspace.arrange` (grouping and layout presets), `workspace.focus`, `workspace.scroll`, `workspace.read` (what's on screen now).

## Protocol (draft)

- Nodes with `workspace@1` receive `workspace.state` (full) on attach, then `workspace.patch` (JSON Patch + version).
- Nodes send `workspace.changed` when a human moves, closes or scrolls a window.

Open questions for the phase-6 ADR: patch format, how `stream` content is transported, and how a TUI with `workspace@1` renders windows (a list, most likely).
