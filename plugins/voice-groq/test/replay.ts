/**
 * Replays committed fixtures through an injected `fetch` (R-13: tests never hit the network).
 * `.json` fixtures hold a status, optional headers and a JSON body. Other fixtures are raw bytes,
 * streamed in small pieces to exercise chunk boundaries. Several names replay one per request.
 */

export type RecordedRequest = { url: string; init: RequestInit }

export type Replay = { fetch: typeof fetch; requests: RecordedRequest[]; readonly cancelled: number }

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url))

type JsonFixture = { status: number; headers?: Record<string, string>; body: unknown }

export function replay(names: string | string[], opts: { pieceSize?: number } = {}): Replay {
  const queue = typeof names === 'string' ? [names] : [...names]
  const requests: RecordedRequest[] = []
  let cancelled = 0
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(input), init })
    const name = queue.length > 1 ? (queue.shift() as string) : (queue[0] as string)
    if (name.endsWith('.json')) {
      const f = (await fixture(name).json()) as JsonFixture
      return new Response(JSON.stringify(f.body), {
        status: f.status,
        headers: { 'content-type': 'application/json', ...f.headers },
      })
    }
    const bytes = new Uint8Array(await fixture(name).arrayBuffer())
    const size = opts.pieceSize ?? 37
    let offset = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < bytes.length) {
          controller.enqueue(bytes.slice(offset, offset + size))
          offset += size
          return
        }
        controller.close()
      },
      cancel() {
        cancelled++
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
  }
  return {
    fetch: fn as typeof fetch,
    requests,
    get cancelled() {
      return cancelled
    },
  }
}

export async function fixtureBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await fixture(name).arrayBuffer())
}
