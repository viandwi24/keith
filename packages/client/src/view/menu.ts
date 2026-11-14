import { type ViewMenu, ViewMenuSchema } from '@keith/contracts'

export type ViewMenuFailure = 'unauthorized' | 'unavailable'

/** The menu could not be read: `unauthorized` for a 401, `unavailable` for anything else (core down, bad answer). */
export class ViewMenuError extends Error {
  constructor(
    readonly reason: ViewMenuFailure,
    message: string,
  ) {
    super(message)
    this.name = 'ViewMenuError'
  }
}

/** `GET /plugins/tui/menu`: the terminal views this credential may open. */
export async function fetchViewMenu(options: {
  core: string
  /** The bearer; none on the local socket (`fetch` carries the `unix` option). */
  credential?: string
  fetch?: typeof fetch
}): Promise<ViewMenu> {
  const doFetch = options.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(`${options.core.replace(/\/+$/, '')}/plugins/tui/menu`, {
      headers:
        options.credential === undefined ? {} : { authorization: `Bearer ${options.credential}` },
    })
  } catch {
    throw new ViewMenuError('unavailable', 'core is not reachable')
  }
  if (res.status === 401) throw new ViewMenuError('unauthorized', 'the credential is not accepted')
  if (!res.ok) throw new ViewMenuError('unavailable', `the menu answered ${res.status}`)
  const parsed = ViewMenuSchema.safeParse(await res.json().catch(() => undefined))
  if (!parsed.success) throw new ViewMenuError('unavailable', 'the menu answer is not valid')
  return parsed.data
}
