# packages/host

The Keith plugin layer (ADR-0016, docs/specs/plugins.md): `defineKeithPlugin` and `defineOperation`, the guard, the context `k`, the OpenAPI builder and the
testing kit (`@keith/host/testing`).

- Plugins import only this package and `@keith/contracts`. The core adapter (eharness, Hono) lives in `apps/core/src/modules/plugins`, never here.
- No I/O, no eharness, no Hono in this package. Time and storage come in through ports (`Clock`, `AuditPort`, `ActorDirectory`, `AclStore`).
- Every call passes `createGuard().run`; a refusal before `run` is one error, `NOT_FOUND` "not found or not permitted". Never add a path around the guard.
- The context `k` is built per execute call from the live principal; never cache it.
- `src/tui/` and `src/views.ts` are the one place that imports Ink, React, chalk and `@keith/ui` (plugin terminal views, docs/specs/plugin-views.md); `@keith/host/tui` is what a view imports, `@keith/host/views` is the core's (`check-imports` enforces both). Never re-export `useStdout`, `useStderr` or `useStdin` there.
