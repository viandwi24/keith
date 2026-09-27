/**
 * Replays a committed fixture through an injected `fetch` (R-13: tests never hit the network).
 * `.sse` fixtures stream in small pieces to exercise chunk boundaries; `.json` fixtures hold a
 * status, optional headers and a JSON body.
 */

export type RecordedRequest = { url: string; init: RequestInit; body: Record<string, unknown> | undefined }

export type Replay = { fetch: typeof fetch; requests: RecordedRequest[]; readonly cancelled: boolean }

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url))

type JsonFixture = { status: number; headers?: Record<string, string>; body: unknown }

export function replay(name: string, opts: { pieceSize?: number } = {}): Replay {
  const requests: RecordedRequest[] = []
  let cancelled = false
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({
      url: String(input),
      init,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    })
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
        cancelled = true
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return {
    fetch: fn as typeof fetch,
    requests,
    get cancelled() {
      return cancelled
    },
  }
}
