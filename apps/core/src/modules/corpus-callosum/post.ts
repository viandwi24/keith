// The `room_post` tool of the front agent (docs/specs/corpus-callosum.md "Private requests and results"; ADR-0026 §3, ADR-0020 §2).
// A person who is active in a room can share a result of their own chat with that room. The tool never posts: it writes one
// `room_requests` row of kind `post`, named for that person, with the exact text. The text reaches the room only when the person
// confirms it (`rooms.confirm`, `service.confirm`). The person is the turn's principal, never an argument. The tool is offered only
// while the person is active in a room (`step.prepare` drops it otherwise), and it refuses again when it runs, so a room that
// ended between two steps cannot be posted to.
import { ROOM_TEXT_MAX } from '@keith/contracts'
import type { RoomsRepo } from '@keith/db'
import { type Tool, tool } from 'ai'
import { definePlugin, type HarnessContext, type HarnessPlugin } from 'eharness'
import { z } from 'zod'
import { RoomError, type RoomService } from './service.ts'

export const ROOM_POST_TOOL = 'room_post'
export const ROOM_POST_PLUGIN = 'keith-corpus-callosum-post'

export const RoomPostInput = z.object({
  roomId: z.string().min(1).max(100),
  text: z.string().min(1).max(ROOM_TEXT_MAX),
})

/** The collaborators of the tool: the active-room lookup of the step and the request writer of the service. */
export interface RoomPostDeps {
  rooms: Pick<RoomsRepo, 'activeRoomOf'>
  service: Pick<RoomService, 'requestPost'>
}

/** What the tool answers. A refusal is an answer, not a thrown error, so the model can tell the person what happened. */
export type RoomPostAnswer =
  | { ok: true; status: 'pending'; message: string }
  | { ok: false; reason: string; message: string }

export const POST_PENDING_MESSAGE =
  'Asked the person to confirm this exact text in their own chat. Nothing is posted to the room until they confirm it.'

/** The room a person is active in now, as the step reminder names it (never the text of anyone else). */
const activeRoomOf = (deps: RoomPostDeps, ctx: HarnessContext) => {
  const personId = ctx.principal?.id
  return personId === undefined ? undefined : deps.rooms.activeRoomOf(personId)
}

/** The tool of one turn: the person is `ctx.principal`, read when the tool runs. */
export function roomPostToolOf(deps: RoomPostDeps) {
  return (ctx: HarnessContext): Tool =>
    tool({
      description:
        'Share a result of this chat with the room the person is active in, when the person asks for it. Pass the roomId from the reminder and the exact text to share. Nothing is posted by this call: the person confirms the exact text first.',
      inputSchema: RoomPostInput,
      metadata: { risk: 'write' },
      execute: async ({ roomId, text }: z.infer<typeof RoomPostInput>): Promise<RoomPostAnswer> => {
        const personId = ctx.principal?.id
        if (personId === undefined)
          return { ok: false, reason: 'no-person', message: 'no person is talking in this chat' }
        try {
          deps.service.requestPost({ by: personId, via: 'local' }, roomId, text)
          return { ok: true, status: 'pending', message: POST_PENDING_MESSAGE }
        } catch (error) {
          if (error instanceof RoomError)
            return { ok: false, reason: error.reason ?? error.code, message: error.message }
          throw error
        }
      },
    })
}

/**
 * Plugin of `room_post`: added to the front agent only (`createFrontAgent`, `roomPost`). At each step it drops the tool from
 * the active tools while the person is not active in a room, and names the room (its id) in a volatile reminder otherwise.
 */
export function createRoomPostPlugin(deps: RoomPostDeps): HarnessPlugin<typeof ROOM_POST_PLUGIN> {
  return definePlugin({
    name: ROOM_POST_PLUGIN,
    setup: () => ({
      tools: { [ROOM_POST_TOOL]: roomPostToolOf(deps) },
      hooks: {
        'step.prepare': (ctx, e) => {
          const room = activeRoomOf(deps, ctx)
          if (room === undefined) {
            if (!e.toolNames.includes(ROOM_POST_TOOL)) return
            return { activeTools: e.toolNames.filter((name) => name !== ROOM_POST_TOOL) }
          }
          const name = room.name.replace(/\s+/g, ' ').slice(0, 60)
          return {
            reminder:
              `You are active in the room "${name}" (roomId ${room.id}). When the person asks to share a result of this chat with it, ` +
              `call ${ROOM_POST_TOOL} with that roomId and the exact text. It asks the person to confirm the text; nothing is posted until they do.`,
          }
        },
      },
    }),
  })
}
