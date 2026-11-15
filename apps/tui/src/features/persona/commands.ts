// The `/persona` forms (docs/specs/tui.md, "Commands and keys"). `/persona` shows the character to anyone; `style` opens the Me screen;
// `template <id>` (owner) changes the template through the step-up; `edit` (owner) opens the Manage section. A refused call (a member's
// template change) shows the core's own words as an error toast, never a crash.

import { summaryOf } from '@keith/app-model/manage'
import type { PersonaApi } from '@keith/client'
import { BUILTIN_PERSONA_TEMPLATE_IDS, type PersonaTemplate } from '@keith/contracts'
import type { ToastLevel } from '@keith/ui'
import type { StepUp } from '../stepup/index.ts'

export type PersonaCommand =
  | { kind: 'show' }
  | { kind: 'style' }
  | { kind: 'template'; templateId: PersonaTemplate }
  | { kind: 'edit' }
  | { kind: 'usage'; text: string }

export const PERSONA_USAGE =
  'Usage: /persona · /persona style · /persona template <id> · /persona edit'

const TEMPLATE_USAGE = `Usage: /persona template <id> (${BUILTIN_PERSONA_TEMPLATE_IDS.join(', ')})`

const usage = (text: string): PersonaCommand => ({ kind: 'usage', text })

/** The words after `/persona`: nothing (show), `style`, `template <id>`, `edit`. */
export function parsePersonaCommand(args: string): PersonaCommand {
  const words = args
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
  const [sub, id, ...rest] = words
  if (sub === undefined) return { kind: 'show' }
  if (sub === 'style') return words.length === 1 ? { kind: 'style' } : usage(PERSONA_USAGE)
  if (sub === 'edit') return words.length === 1 ? { kind: 'edit' } : usage(PERSONA_USAGE)
  if (sub === 'template') {
    if (id === undefined || rest.length > 0) return usage(TEMPLATE_USAGE)
    const templateId = BUILTIN_PERSONA_TEMPLATE_IDS.find((t) => t === id)
    return templateId === undefined ? usage(TEMPLATE_USAGE) : { kind: 'template', templateId }
  }
  return usage(PERSONA_USAGE)
}

/** What a `/persona` command reads and does: the person's role, the client, the notice and toast, the screens to open. */
export interface PersonaCommandEnv {
  isMember: boolean
  persona: PersonaApi
  /** The step-up guard: an owner's template change waits for the PIN when the core asks for it. */
  guard: StepUp['guard']
  say(level: 'info' | 'warning', rows: readonly string[]): void
  toast(text: string, level: ToastLevel): void
  /** Open the Me screen (the person's own style). */
  openStyle(): void
  /** Open the Manage screen on the Persona section (owner). */
  openEdit(): void
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Runs a parsed `/persona` command. `show` reads the persona and says its template and version. `template` runs `persona.setTemplate`
 * through the guard; a member's call is refused by the core and the core's message is the error toast. `edit` is the owner's: a member
 * is told to ask the owner, and the owner's Manage opens on the Persona section.
 */
export function runPersonaCommand(command: PersonaCommand, env: PersonaCommandEnv): void {
  const failed = (e: unknown): void => env.toast(messageOf(e), 'error')
  switch (command.kind) {
    case 'usage':
      env.say('info', [command.text])
      return
    case 'style':
      env.openStyle()
      return
    case 'edit':
      if (env.isMember) env.say('info', ['Only the owner edits the persona.'])
      else env.openEdit()
      return
    case 'show':
      void env.persona.get().then((view) => {
        env.say('info', [`Persona: ${summaryOf(view)}`])
      }, failed)
      return
    case 'template':
      void env
        .guard(() => env.persona.setTemplate({ templateId: command.templateId }))
        .then((view) => env.toast(`Persona: ${summaryOf(view)}.`, 'success'), failed)
  }
}
