import { describe, expect, test } from 'bun:test'
import type { Guard } from '../guard.ts'
import type { KeithPlugin } from '../types.ts'
import { createViewKeith, type ViewEventsPort, type Viewer } from './view-keith.ts'

// `keith.events(target, handler, options)` (plugin-views.md, "Data and operations"): the options, `onResync` in particular,
// reach the port unchanged; with no port the call is a no-op unsubscribe.

const viewer: Viewer = { principalId: 'ana', method: 'password' }
const signal = new AbortController().signal

function recordingPort(): { port: ViewEventsPort; calls: unknown[][] } {
  const calls: unknown[][] = []
  const port: ViewEventsPort = {
    subscribe(...args) {
      calls.push(args)
      return () => {}
    },
  }
  return { port, calls }
}

function setup(port?: ViewEventsPort) {
  const make = createViewKeith({
    guard: {} as Guard,
    plugins: () => [] as readonly KeithPlugin[],
    ...(port === undefined ? {} : { events: port }),
  })
  return make(viewer, 'notes.list', signal)
}

describe('view keith: events options', () => {
  test('the options reach the port with the viewer, the plugin and the event name', () => {
    const { port, calls } = recordingPort()
    const onResync = () => {}
    const handler = () => {}
    setup(port).events('notes.note.created', handler, { onResync })
    expect(calls).toHaveLength(1)
    const [viewerArg, plugin, event, handlerArg, options] = calls[0] ?? []
    expect(viewerArg).toBe(viewer)
    expect([plugin, event]).toEqual(['notes', 'note.created'])
    expect(handlerArg).toBe(handler)
    expect((options as { onResync?: unknown }).onResync).toBe(onResync)
  })

  test('without options the port gets no options argument', () => {
    const { port, calls } = recordingPort()
    setup(port).events('notes.note.created', () => {})
    expect(calls[0]?.[4]).toBeUndefined()
  })

  test('no port: a no-op unsubscribe is returned and nothing is subscribed', () => {
    const off = setup().events('notes.note.created', () => {}, { onResync() {} })
    expect(typeof off).toBe('function')
    expect(() => off()).not.toThrow()
  })
})
