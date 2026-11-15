# App model (`@keith/app-model`)

Code: `packages/app-model/src`. Decision: `docs/decisions/0035-web-client.md` (point 5, "Logic is shared, not rewritten").

The framework-free state and action logic that the TUI and the web client share, so each client keeps only its rendering. No Ink, React or
Svelte, no DOM, no Bun API. It imports only `@keith/contracts`, `@keith/client` (through `@keith/client/browser`, the Node-free entry), the
Ink-free `@keith/ui/tokens` and `@keith/ui/orb` (the glyph set; the orb mode type) and, as types only, `ai` (`UIMessage`). `scripts/check-imports.ts` enforces this
(`app-model-npm-allowlist`, `app-model-pure-imports`).

| Module | Holds |
| --- | --- |
| `message-text` | `toItems(messages)`: user, assistant (text and tool blocks in order; an assistant message is split at each `data-eh.input` part with `source: 'user'`, an approval note or a steer, into assistant → user row → assistant, the row showing `approvalNote.text` (the raw words) or else `text`; other sources never show; later segments have id `<id>:s<n>`, the row `<id>:input:<i>`), notice, question, divider items; `noticeText`, `questionOf`, `dreamNoticeOf`, the part names |
| `tool-view` | `toolCallOf`, `toolLineOf` (the one-line view of a tool call or delegation), `outputLinesOf`, `taskFor` |
| `slash` | The TUI's command list, `matchCommands`, `completeCommand` |
| `context-commands` | `/new` and `/compact` forms, refusal and done texts, `runContextCommand` |
| `context-pending` | The context-change state (`reduceContextPending`), the hold and refusal texts, `draftRestoredOf` |
| `history-state` | `historyRowsOf` for `/history` |
| `dream-marks`, `dream-pending`, `dream-state` | Dream dividers in the chat, the running line and the words of a run |
| `question-state` | `answerableOf`, `Settled`, `codeOf`, `messageOf` |
| `approval-state` | `askOf` (sentence, whole command, `desktop.input` actions in words), `describeApproval`, `approvalsOf`, `oldestFirst`, `lifeOf` and `askedAgo` (age, expiry), `isScopable`, `isWaitingForOwner` |
| `approval-headline` | `actionOf` (the human phrase of a tool call: `switch the persona to butler`, `run \`df -h\` on laptop-e`; `undefined` for a tool without one), `hidesTaskGrant` (persona, model, style, status and undo tools never offer "allow for task") |
| `consent-state` | ADR-0036 §7 routing: `consentOf` (`extra.consent`), `routeOf` (`conversation`, `device`, `other` when `extra.askedBy`, `legacy` when the core sends no tier), `groupApprovals`, `offersTaskGrant`, `summaryOf`, `expiresIn`, `quietLineOf` (the line above the composer: `Keith is waiting for your yes or no · <summary> · expires in m:ss`, or `Confirm in the Inbox · <summary>`; none for `legacy`), `newInboxIds` (toast once per Inbox request) |
| `step-up-state` | `KEITH_WAITING_FOR_OWNER`, `WAITING_TEXT`, `isStepUpRequired`, `isWaitingForOwnerError`, `StepUpCancelled`, `stepUpFailure` (texts, including a PIN session), `isDeadEnd`, `remaining` |
| `step-up-controller` | `StepUpController`: the guard state machine (`guard`, `elevate`, `submit`, `setMethod`, `cancel`, `subscribe`, `getSnapshot`); `useStepUp` (TUI) and `stepUp` (web) wrap it; the optional `preferMethod` picks the tab the prompt opens on (the web passes `password` for a PIN session, which cannot step up with its PIN) |
| `tasks` | Task board helpers: merge, elapsed, status glyph and tone, `taskChangedOf` |
| `front-generation` | `currentGenerationOf` |
| `brain-state` | The brain panel's state: `reduceBrain`, `resyncBrain`, `viewOf` (lamps: lit, working, idle), `lampOf`, `describeEvent`, `dreamLineOf`, `traceText` (an event without its region name), `BRAIN_REGIONS` (the eleven regions), `FADE_MS` |
| `home-model` | `orbModeOf` (alert, speaking, thinking, listening, idle), `regionOf` and `strengthOf` (brain event to the trace), `plainText` (Markdown to the subtitle's words), `SUBTITLE_HOLD_MS` |
| `budget-state` | `spendTone` (warning from 80 %, danger from 100 %), `headerSpend`, `budgetRows`, `ownBudgetRows`, `personCells`, `usd` |
| `nodes-state` | `countNodes`, `sortNodes`, `mergeNodes`, `nodeChangedOf`, `driverLines`, `formatLastSeen` |
| `presence-state` | The Presence screen's logic: `LEVELS`, `nextLevel`, `disclosureRowsOf` (owner, `@users`, groups), `stateLine`, `stateTone`, `clockOf`, `parseBusy` (`/busy`), `statusReply` |
| `style-state` | The Me style form: `styleDraftOf`, `checkAddress` (the contract's own check), `toggleTopic`, `dirtyStyleFieldsOf`, `stylePatchOf`, the field labels and choices |
| `room-state` | Rooms: `bannerOf`, `inviteNoticeOf`, `activeRoomOf`, `roomViewOf` (transcript, members with presence dots, indicator, the one confirmation), `lineOf`, `dotOfPresence`, `roomQuestionOf` (the TUI re-exports it as `questionOf`; `message-text` has its own `questionOf`) |
| `menu-tree` | The TUI's two-level menu: `menuTree`, `isGroup`, `MenuEntry`, `MenuTarget` (the web's command palette lists the same groups) |
| `ui-types` | `Tone`, `NoticeLevel`, `ToastLevel`, `ToolLineView`: plain types shaped like the TUI's |

## `@keith/app-model/manage`

A second entry (`src/manage/`, `exports["./manage"]`) holds the Manage logic of both clients. It is a subpath because its names are
section-specific (`usd`, `personCells`, `stampOf`) and would clash with the flat entry.

| Module | Holds |
| --- | --- |
| `types` | `FieldSpec` (`secret`, `options`, `multiline`), `NoteSpec`, `Outcome`, `ActionSpec` (`confirm`, `run`), `Row`, `SectionBody`, `SectionData`, `SectionEnv`, `SectionModel` (`load`, `build`), `SectionId` |
| `sections` | `SECTION_META` (id, title, read capabilities, in the list's order), `sectionModel(id, env)`, `isTableSection` |
| `<section>-section` | One model per table section (`people`, `groups`, `plugins`, `reviews`, `protocols`, `devices`, `nodes`, `providers`, `persona`, `access`, `succession`, `budget`, `privacy`, `audit`, `overview`): `load` reads through `client.rpc.*`, `build` makes the lines, header, rows and actions. The TUI reads it with `useSectionModel`, the web with `SectionStore` |
| `*-state`, `*-actions` | The row builders, texts and parsers of each section, and the actions that call `client.rpc.admin.*` (the `keith-core` calls) |
| `manage-state`, `dialog-state` | `capsOf`, `visibleSections`, the TUI's navigation and row cursor; the dialog reducer (`openAction`, `setValue`, `missingField`, `confirmReady`, `clearSecrets`, `submitValues`) the web's `ActionFlow` also follows |
| `providers-form` | `providerFieldSpecs`, `providerSettings`, `missingSetting`: the add-connection form drawn from a provider's field list |
| `audit-filter` | `filterAudit`, `auditChoices` |
| `logs-state`, `logs-format`, `cache-hit`, `logs-chart` | The Logs state machine (`reduceLogs`, `sessionsInput`), the fact and body lines (`sessionLines`, `callLines`, `rawLines`, `microUsd`), the cache-hit figures and the chart geometry (`barsOf`, `metricOf`) |
| `persona-state`, `protocols-*`, `succession-*` | The persona draft and patch, the protocol rows and reminder parser, the succession texts and parsers |

A section never wraps the step-up guard: the client runs `action.run` through its own `guard`.

Each client adds its own rendering and effects (`useFrontGeneration` in the TUI, `ChatController` in the web). A module moves here when a
second client needs it; its tests move with it (`bun test ./packages/app-model`).
