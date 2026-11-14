import { describe, expect, mock, test } from 'bun:test'
import type { RoomsApi } from '@keith/client'
import type { ToastLevel } from '@keith/ui'
import {
  parseRoomCommand,
  ROOM_USAGE,
  type RoomCommandEnv,
  runRoomCommand,
} from './room-command.ts'
import type { LocalAsk } from './room-screen.tsx'

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('parsing /room', () => {
  test('the forms of the command', () => {
    expect(parseRoomCommand('')).toEqual({ kind: 'open' })
    expect(parseRoomCommand('  start   ana   duta ')).toEqual({
      kind: 'start',
      invite: ['ana', 'duta'],
    })
    expect(parseRoomCommand('invite ana')).toEqual({ kind: 'invite', person: 'ana' })
    expect(parseRoomCommand('leave')).toEqual({ kind: 'leave' })
    expect(parseRoomCommand('remove duta')).toEqual({ kind: 'remove', person: 'duta' })
    expect(parseRoomCommand('end')).toEqual({ kind: 'end' })
  })

  test('a missing or extra argument is a usage line, an unknown word the usage of the command', () => {
    expect(parseRoomCommand('start')).toEqual({
      kind: 'usage',
      text: 'Usage: /room start <user> [<user>…]',
    })
    expect(parseRoomCommand('invite')).toEqual({
      kind: 'usage',
      text: 'Usage: /room invite <user>',
    })
    expect(parseRoomCommand('invite ana duta')).toEqual({
      kind: 'usage',
      text: 'Usage: /room invite <user>',
    })
    expect(parseRoomCommand('leave now')).toEqual({ kind: 'usage', text: 'Usage: /room leave' })
    expect(parseRoomCommand('dance')).toEqual({ kind: 'usage', text: ROOM_USAGE })
  })
})

function envOf(over: Partial<RoomCommandEnv> = {}) {
  const rooms = {
    start: mock(async (_input: unknown) => ({ room: { id: 'r2' } })),
    invite: mock(async (_input: unknown) => ({})),
    leave: mock(async (_input: unknown) => ({ ok: true })),
    remove: mock(async (_input: unknown) => ({ ok: true })),
    end: mock(async (_input: unknown) => ({ ok: true })),
  }
  const raw = {
    say: mock((_level: 'info' | 'warning', _rows: readonly string[]) => {}),
    toast: mock((_text: string, _level: ToastLevel) => {}),
    open: mock((_roomId: string, _ask?: LocalAsk) => {}),
    goHome: mock(() => {}),
    reload: mock(() => {}),
  }
  const env: RoomCommandEnv = {
    active: { roomId: 'r1', name: 'Planning' },
    invited: false,
    rooms: rooms as unknown as RoomsApi,
    ...raw,
    ...over,
  }
  return { env, rooms, raw }
}

describe('running /room', () => {
  test('/room opens the active room; with only an invitation it goes Home; alone it says how to start', () => {
    const active = envOf()
    runRoomCommand({ kind: 'open' }, active.env)
    expect(active.raw.open).toHaveBeenCalledWith('r1')

    const invited = envOf({ active: undefined, invited: true })
    runRoomCommand({ kind: 'open' }, invited.env)
    expect(invited.raw.goHome).toHaveBeenCalled()

    const alone = envOf({ active: undefined })
    runRoomCommand({ kind: 'open' }, alone.env)
    expect(alone.raw.say.mock.calls[0]?.[1][0]).toContain('/room start')
  })

  test('start opens the new room; a refusal is an error toast with the core words', async () => {
    const ok = envOf()
    runRoomCommand({ kind: 'start', invite: ['duta'] }, ok.env)
    await flush()
    expect(ok.rooms.start).toHaveBeenCalledWith({ invite: ['duta'] })
    expect(ok.raw.open).toHaveBeenCalledWith('r2')

    const refused = envOf()
    refused.rooms.start = mock(async () => {
      throw new Error('FORBIDDEN: no capability rooms.start')
    })
    runRoomCommand({ kind: 'start', invite: ['duta'] }, refused.env)
    await flush()
    expect(refused.raw.toast).toHaveBeenCalledWith('FORBIDDEN: no capability rooms.start', 'error')
    expect(refused.raw.open).not.toHaveBeenCalled()
  })

  test('invite and leave act on the active room and toast the result', async () => {
    const e = envOf()
    runRoomCommand({ kind: 'invite', person: 'duta' }, e.env)
    await flush()
    expect(e.rooms.invite).toHaveBeenCalledWith({ roomId: 'r1', invite: ['duta'] })
    expect(e.raw.toast).toHaveBeenCalledWith('Invited duta.', 'success')
    runRoomCommand({ kind: 'leave' }, e.env)
    await flush()
    expect(e.rooms.leave).toHaveBeenCalledWith({ roomId: 'r1' })
  })

  test('without an active room, invite and leave say so and call nothing', () => {
    const e = envOf({ active: undefined })
    runRoomCommand({ kind: 'leave' }, e.env)
    expect(e.raw.say).toHaveBeenCalledWith('info', ['You are not in a room.'])
    expect(e.rooms.leave).not.toHaveBeenCalled()
  })

  test('remove and end open the room with a confirmation; the call runs only on y', async () => {
    const e = envOf()
    runRoomCommand({ kind: 'remove', person: 'duta' }, e.env)
    const removeAsk = e.raw.open.mock.calls[0]?.[1] as unknown as {
      question: string
      run(): Promise<void>
    }
    expect(removeAsk.question).toBe('Remove duta from the room?')
    expect(e.rooms.remove).not.toHaveBeenCalled()
    await removeAsk.run()
    expect(e.rooms.remove).toHaveBeenCalledWith({ roomId: 'r1', person: 'duta' })

    runRoomCommand({ kind: 'end' }, e.env)
    const endAsk = e.raw.open.mock.calls[1]?.[1] as unknown as {
      question: string
      run(): Promise<void>
    }
    expect(endAsk.question).toBe('End the room "Planning"?')
    expect(e.rooms.end).not.toHaveBeenCalled()
    await endAsk.run()
    expect(e.rooms.end).toHaveBeenCalledWith({ roomId: 'r1' })
  })
})
