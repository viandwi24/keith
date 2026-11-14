// The current generation of the person's front session (docs/specs/chat-context.md, "TUI"). It is read from `chat.generations` (the
// last entry) and read again on each `chat.context.changed` and on every feed resync, so a second open TUI of the person switches
// without a restart. A failed read keeps the last generation.
import { type KeithClient, watchChatContext } from '@keith/client'
import { useEffect, useState } from 'react'

/** The generation now current: the last of `chat.generations` (oldest first), 0 when the list is empty. */
export function currentGenerationOf(list: readonly { generation: number }[]): number {
  return list.at(-1)?.generation ?? 0
}

/** The current generation of `personId`'s front session; 0 until the first read (and while no person is known). */
export function useFrontGeneration(client: KeithClient, personId: string | undefined): number {
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    if (personId === undefined) return undefined
    let live = true
    // reads can answer out of order: only the newest read sets the generation
    let latest = 0
    const refetch = (): void => {
      const mine = ++latest
      client.chatContext.generations().then(
        (list) => {
          if (live && mine === latest) setGeneration(currentGenerationOf(list))
        },
        () => undefined,
      )
    }
    const off = watchChatContext({ feed: client.feed(), refetch })
    refetch()
    return () => {
      live = false
      off()
    }
  }, [client, personId])
  return generation
}
