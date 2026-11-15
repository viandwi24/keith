# packages/eh-ext

Local extensions on top of eharness 0.14.1, built only on its public API. It exports the tool traits Keith adds next to eharness' `risk` (`toolSource`, `toolReversible`, `declaresSource`, `EHARNESS_TOOL_TRAITS`, `eharnessConsentRisk`; ADR-0036, `docs/specs/permissions.md` "Tool risk"). The eharness adapters Keith owns (stream log, person store, activity store, budget ledger, inbox, schedules) live in `packages/db/src/eh`; put Keith-only glue that is not a database adapter here.

- First line of every file: why it lives here and which upstream module would replace it.
- Shape follows eharness: port + memory adapter + conformance test, `definePlugin`.
- When eharness releases a new version, delete what upstream now provides.
