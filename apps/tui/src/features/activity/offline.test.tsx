import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render } from '@keith/ui/testing'
import { Text } from 'ink'
import {
  LinkProvider,
  OfflineKeys,
  offlineReason,
  useGuardedInput,
  useLink,
  useLinkValue,
} from './offline.tsx'
import type { ConnectionState } from './use-connection.ts'

afterEach(cleanup)

const conn = (over: Partial<ConnectionState> = {}): ConnectionState => ({
  kind: 'disconnected',
  loggedOut: false,
  retry: () => true,
  ...over,
})

function setup(connection: ConnectionState) {
  const handled: string[] = []
  const said: string[][] = []
  let cleared = 0
  function Screen() {
    useGuardedInput((input, key) => {
      handled.push(key.escape ? 'esc' : key.upArrow ? 'up' : key.ctrl ? `ctrl+${input}` : input)
    })
    return <Text>screen</Text>
  }
  function Host() {
    const value = useLinkValue(
      connection,
      'unix:~/.keith/core.sock',
      (rows) => said.push(rows),
      () => cleared++,
    )
    return (
      <LinkProvider value={value}>
        <Screen />
        <OfflineKeys />
      </LinkProvider>
    )
  }
  const view = render(<Host />, { columns: 40, rows: 3 })
  return { view, handled, said, cleared: () => cleared }
}
const write = async (view: { stdin: { write(d: string): void } }, data: string) => {
  view.stdin.write(data)
  await Bun.sleep(15)
}

describe('the guarded input', () => {
  test('live: every key reaches the screen', async () => {
    const { view, handled, said } = setup(conn({ kind: 'live' }))
    await Bun.sleep(15)
    await write(view, 'x')
    await write(view, ' ')
    expect(handled).toEqual(['x', ' '])
    expect(said).toEqual([])
  })

  test('disconnected: an ordinary key is refused with one line, no silent no-op', async () => {
    const { view, handled, said } = setup(conn({ reason: 'connection refused' }))
    await Bun.sleep(15)
    await write(view, 'x')
    await write(view, '\r')
    expect(handled).toEqual([])
    expect(said).toEqual([
      [
        'offline: cannot reach the core (unix:~/.keith/core.sock, connection refused) · [r] retry now',
      ],
      [
        'offline: cannot reach the core (unix:~/.keith/core.sock, connection refused) · [r] retry now',
      ],
    ])
  })

  test('esc, the arrows and ctrl+c stay active offline', async () => {
    const { view, handled, said } = setup(conn({ kind: 'reconnecting' }))
    await Bun.sleep(15)
    await write(view, '\u001b')
    await Bun.sleep(80) // a lone escape is held back a moment, in case it starts a sequence
    await write(view, '\u001b[A')
    await write(view, '\u0003')
    expect(handled).toEqual(['esc', 'up', 'ctrl+c'])
    expect(said).toEqual([])
  })

  test('r is the retry key: it is not a refused key and calls retry', async () => {
    let retries = 0
    const { view, handled, said } = setup(
      conn({
        retry: () => {
          retries++
          return true
        },
      }),
    )
    await Bun.sleep(15)
    await write(view, 'r')
    expect(retries).toBe(1)
    expect(handled).toEqual([])
    expect(said).toEqual([])
  })

  test('a retry that is refused (once per 3 s) says so', async () => {
    const { view, said } = setup(conn({ retry: () => false }))
    await Bun.sleep(15)
    await write(view, 'r')
    expect(said).toHaveLength(1)
    expect(said[0]?.[0]).toContain('offline:')
  })

  test('the hint clears after 3 s and no timer is left after unmount', async () => {
    const { view, cleared } = setup(conn())
    await Bun.sleep(15)
    await write(view, 'x')
    expect(cleared()).toBe(0)
    await Bun.sleep(3_100)
    expect(cleared()).toBe(1)
    await write(view, 'x')
    view.unmount()
    await Bun.sleep(3_100)
    expect(cleared()).toBe(1) // the second toast's timer was cleared with the screen
  }, 15_000)
})

test('the reason names what could not be reached and the last error', () => {
  expect(offlineReason({ kind: 'disconnected', reason: 'timeout' }, 'http://x:1')).toBe(
    'cannot reach the core (http://x:1, timeout)',
  )
  expect(offlineReason({ kind: 'reconnecting' }, 'http://x:1')).toBe(
    'cannot reach the core (http://x:1)',
  )
})

test('two apps in one process have independent link states (no global store)', async () => {
  const states: string[] = []
  function Probe({ name }: { name: string }) {
    const link = useLink()
    states.push(`${name}:${link === undefined ? 'live' : 'down'}`)
    return <Text>{name}</Text>
  }
  function Host({ name, connection }: { name: string; connection: ConnectionState }) {
    const value = useLinkValue(
      connection,
      'x',
      () => {},
      () => {},
    )
    return (
      <LinkProvider value={value}>
        <Probe name={name} />
      </LinkProvider>
    )
  }
  render(<Host name="a" connection={conn()} />, { columns: 20, rows: 2 })
  render(<Host name="b" connection={conn({ kind: 'live' })} />, { columns: 20, rows: 2 })
  await Bun.sleep(15)
  expect(states).toContain('a:down')
  expect(states).toContain('b:live')
  expect(states).not.toContain('b:down')
  expect(states).not.toContain('a:live')
  // a screen with no provider above is live
  states.length = 0
  render(<Probe name="c" />, { columns: 20, rows: 2 })
  expect(states).toEqual(['c:live'])
})
