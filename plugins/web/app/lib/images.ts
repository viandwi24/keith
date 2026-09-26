import { isAllowedUiUrl } from '@keith/protocol'

/**
 * Where a UI block's image comes from (docs/contracts/ui-blocks.md): `https:` and `data:image/*`
 * URLs are used as they are; core files (`/v1/files/<id>`) need the bearer token, so their bytes
 * are fetched with an `Authorization` header and shown from an object URL. Anything else is refused.
 */
export type ImageSource =
  | { kind: 'direct'; src: string }
  | { kind: 'core-file'; path: string }
  | { kind: 'refused' }

export function imageSource(url: string): ImageSource {
  if (!isAllowedUiUrl(url)) return { kind: 'refused' }
  if (url.startsWith('/v1/files/')) return { kind: 'core-file', path: url }
  return { kind: 'direct', src: url }
}

export type FileFetchDeps = {
  baseUrl: string
  token: string
  fetch?: ((input: string, init: RequestInit) => Promise<Response>) | undefined
}

/** Fetches a core file with the bearer token. Resolves to a Blob, or throws on an HTTP error. */
export async function fetchCoreFile(deps: FileFetchDeps, path: string, signal?: AbortSignal): Promise<Blob> {
  const doFetch = deps.fetch ?? fetch
  const res = await doFetch(`${deps.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${deps.token}` },
    ...(signal ? { signal } : {}),
  })
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`)
  return res.blob()
}
