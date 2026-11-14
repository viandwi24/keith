// The `presence` tool of the front agent (docs/specs/parietal.md, "The presence tool", ADR-0025 §4, ADR-0020 §2).
// The viewer is the turn's principal, never an argument; the answer is only the line the disclosure rule released.
// Unknown people, suspended people, guests and refusals all answer `{ disclosed: false }`, so nothing leaks through
// the answer's shape. A worker does not get this tool.
import type { Person } from '@keith/contracts'
import { tool } from 'ai'
import { definePlugin, type HarnessContext, type HarnessPlugin } from 'eharness'
import { z } from 'zod'
import type { AclActors } from '../acl/index.ts'
import type { PeopleService } from '../people/index.ts'
import type { ParietalPorts } from './ports.ts'

export const PRESENCE_TOOL = 'presence'

/** What the tool answers: the released line, or nothing. */
export interface PresenceAnswer {
  disclosed: boolean
  line?: string
}

export interface PresenceToolOptions {
  parietal: Pick<ParietalPorts, 'disclosedFor'>
  people: Pick<PeopleService, 'get' | 'list'>
  actors: AclActors
}

const NOT_DISCLOSED: PresenceAnswer = { disclosed: false }

/**
 * A person named by `me`, a username, an id, or a display name that only one person has. Undefined when none matches
 * (an ambiguous name matches nobody).
 */
export async function resolvePerson(
  people: Pick<PeopleService, 'get' | 'list'>,
  ref: string,
  viewerId: string,
): Promise<Person | undefined> {
  const text = ref.trim()
  if (text === '') return undefined
  if (text.toLowerCase() === 'me') return people.get(viewerId).catch(() => undefined)
  const byRef = await people.get(text).catch(() => undefined)
  if (byRef !== undefined) return byRef
  const wanted = text.toLowerCase()
  const named = (await people.list()).filter((p) => p.name.trim().toLowerCase() === wanted)
  return named.length === 1 ? named[0] : undefined
}

/** The tool of one turn: `ctx.principal` is read when the tool runs, so the viewer is the person who asked. */
export function presenceToolOf(options: PresenceToolOptions) {
  return (ctx: HarnessContext) =>
    tool({
      description:
        'Whether a person is free or busy, as far as that person shares it with you. Pass the person as a username, a name, or "me". The answer is {disclosed: false} when nothing is shared; never guess the state of anyone.',
      inputSchema: z.object({
        person: z.string().min(1).max(100).describe('a username, a name, or "me"'),
      }),
      metadata: { risk: 'read' },
      execute: async ({ person }: { person: string }): Promise<PresenceAnswer> => {
        try {
          const viewer = await options.actors.of(ctx.principal)
          if (viewer === undefined) return NOT_DISCLOSED
          const subject = await resolvePerson(options.people, person, viewer.id)
          if (subject === undefined) return NOT_DISCLOSED
          const released = await options.parietal.disclosedFor(viewer.id, subject.id)
          if (released.level === 'none' || released.line === null) return NOT_DISCLOSED
          return { disclosed: true, line: released.line }
        } catch {
          return NOT_DISCLOSED
        }
      },
    })
}

/** Plugin of `presence`: added to the front agent only (`modules/wernicke-broca/agent.ts`). */
export function presenceTool(
  options: PresenceToolOptions,
): HarnessPlugin<'keith-parietal-presence'> {
  return definePlugin({
    name: 'keith-parietal-presence',
    setup: () => ({ tools: { [PRESENCE_TOOL]: presenceToolOf(options) } }),
  })
}
