import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render } from '@keith/ui/testing'
import { Text } from 'ink'
import { type Loaded, useLoad } from './use-load.ts'

afterEach(cleanup)

/** A load whose answer the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useLoad', () => {
  test('an older read that settles after a newer one does not overwrite it', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const loads = [first, second]
    let view: Loaded<string> | undefined
    function Probe() {
      view = useLoad(() => loads.shift()?.promise ?? Promise.resolve('none'))
      return <Text>{view.data ?? 'loading'}</Text>
    }
    render(<Probe />, { columns: 40, rows: 3 })
    view?.reload()
    second.resolve('newer')
    await Bun.sleep(5)
    first.resolve('older')
    await Bun.sleep(5)
    expect(view?.data).toBe('newer')
    expect(view?.loading).toBe(false)
  })

  test('an older failure after a newer answer does not show as an error', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const loads = [first, second]
    let view: Loaded<string> | undefined
    function Probe() {
      view = useLoad(() => loads.shift()?.promise ?? Promise.resolve('none'))
      return <Text>{view.data ?? 'loading'}</Text>
    }
    render(<Probe />, { columns: 40, rows: 3 })
    view?.reload()
    second.resolve('newer')
    await Bun.sleep(5)
    first.reject(new Error('stale'))
    await Bun.sleep(5)
    expect(view?.error).toBeUndefined()
    expect(view?.data).toBe('newer')
  })
})
