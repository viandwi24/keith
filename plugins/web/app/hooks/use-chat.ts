import {
  type AudioEvent,
  type AudioSupport,
  type Auth,
  type ChatClient,
  type ChatState,
  createChatClient,
  type Fetch,
  initialState,
  type StoredSession,
} from '@keith/client'
import type { ClientInfo } from '@keith/protocol'
import { useEffect, useRef, useState } from 'react'

/**
 * What the web app declares in `hello`: text chat and UI blocks. `audio.in@1` / `audio.out@1` are
 * added by the client when the page can record and play audio (`UseChatOptions.audio`).
 */
export const WEB_CAPABILITIES: readonly string[] = ['chat.text@1', 'ui.render@1']

export const WEB_CLIENT: ClientInfo = { name: 'keith-web', version: '0.0.0' }

export type UseChatOptions = {
  baseUrl: string
  session: StoredSession
  auth: Auth
  fetch?: Fetch | undefined
  /** Read once, when the connection is created. */
  audio?: AudioSupport | undefined
  onAudio?: ((event: AudioEvent) => void) | undefined
}

/**
 * One `@keith/client` chat connection for the signed-in session, alive while the component is
 * mounted. The session is read once: a new token after a re-login goes through `client.reconnect`.
 */
export function useChat(opts: UseChatOptions): { state: ChatState; client: ChatClient | null } {
  const [state, setState] = useState<ChatState>(initialState)
  const [client, setClient] = useState<ChatClient | null>(null)
  const first = useRef(opts)

  useEffect(() => {
    const { baseUrl, session, auth, fetch, audio, onAudio } = first.current
    const next = createChatClient({
      baseUrl,
      token: session.token,
      nodeId: session.nodeId,
      client: WEB_CLIENT,
      capabilities: WEB_CAPABILITIES,
      audio,
      onAudio,
      onState: setState,
      onNodeId: (nodeId) => {
        auth.rememberNodeId(nodeId).catch((error: unknown) => console.warn('cannot save the node id', error))
      },
      fetch,
    })
    setClient(next)
    next.start()
    return () => next.close()
  }, [])

  return { state, client }
}
