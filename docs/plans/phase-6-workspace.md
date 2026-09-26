# Phase 6: Workspace (overview)

> Overview only. See [workspace.md](../architecture/workspace.md).

**Goal:** Keith arranges a visual workspace of windows (cards, dashboards, embedded pages, streams), personal or shared by a group thread.

## Lanes (sketch)

| Lane | Work |
|---|---|
| 0 (contract) | ADR + additive protocol: `workspace.state/patch/changed`, `workspace@1` |
| A | Core: workspace state per person and per group thread, persistence, `workspace.*` tools, human changes as events |
| B | Web renderer: window manager (grid layout, groups, focus, scroll sync), consistent theme |
| C | TUI: minimal `workspace@1` (window list with fallback text) |
| I | Integration + S-6 shared-state e2e |
