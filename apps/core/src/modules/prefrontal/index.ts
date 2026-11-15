// Prefrontal region: the persona (versions, owner changes with step-up), the per-person style, the built-in templates and the
// removal part and the answer modes (docs/specs/prefrontal.md).

export {
  createDocumentPlugin,
  DOCUMENT_SAVE_TOOL,
  type DocumentDeps,
  saveDocument,
} from './document-tool.ts'
export {
  answerFailedLine,
  FALLBACK_LINES,
  guestUnavailableLine,
  type PersonaLineKey,
  personaLine,
} from './lines.ts'
export {
  type AnswerMode,
  type ChannelView,
  chooseMode,
  type ModeChoice,
  type ModeInput,
  modeForClients,
  pickChannel,
  type RequestKind,
} from './mode.ts'
export {
  CHAT_PLAIN_TEXT,
  CHAT_TEXT,
  modeText,
  REPORT_TEXT,
  SCREEN_TEXT,
  SPEECH_TEXT,
} from './mode-text.ts'
export { createOnboarding, type OnboardingDeps, type OnboardingOf } from './onboarding.ts'
export {
  createPersonaToolsPlugin,
  PERSONA_APPROVAL_TOOLS,
  PERSONA_TOOLS_PLUGIN,
  type PersonaToolsDeps,
  personaToolsOf,
  type ToolRefusal,
} from './persona-tools.ts'
export {
  type PrefrontalProcedureDeps,
  prefrontalCallerOf,
  prefrontalProcedures,
} from './procedures.ts'
export {
  MEMORY_VOICE_RULE,
  PERSONA_VOICE_RULES,
  personaBlockOf,
  renderAddressLine,
  renderPersonaBlock,
  renderStyleLines,
} from './prompt.ts'
export {
  type PrefrontalRemovalOptions,
  prefrontalRemoval,
  STYLE_FILE,
  type StyleDump,
} from './removal.ts'
export {
  createReportPlugin,
  isLongReport,
  REPORT_BLOCK,
  type ReportDeps,
} from './report.ts'
export {
  createOwnerCheck,
  createPersonaService,
  type PersonaActivity,
  type PersonaService,
  type PersonaServiceOptions,
  type PrefrontalCaller,
  PrefrontalError,
  type PrefrontalErrorCode,
  type PrefrontalRefusal,
  SYSTEM_PREFRONTAL_CALLER,
} from './service.ts'
export { CODE_SPOKEN, speakable, speakableGuard, speakableMessage } from './speakable.ts'
export {
  createPersonStyleService,
  PERSON_STYLE_KIND,
  type PersonStyleService,
  type PersonStyleServiceOptions,
} from './style.ts'
export { templateToBody } from './templates.ts'
