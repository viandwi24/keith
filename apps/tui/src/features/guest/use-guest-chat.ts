import {
  GUEST_END_TEXT,
  type GuestChatEvent,
  type GuestClient,
  GuestError,
  type GuestSessionView,
  guestFailureText,
} from '@keith/client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatBlock, ChatItem } from '../chat/index.ts'

/** `opening`: asking for a session; `ready`: chatting; `refused`: no session could start; `ended`: the chat is over. */
export type GuestPhase = 'opening' | 'ready' | 'refused' | 'ended'

export interface GuestChatState {
  phase: GuestPhase
  session: GuestSessionView | undefined
  items: ChatItem[]
  /** A turn is running. */
  busy: boolean
  /** Messages the chat may still send (the core's count, else the limit minus what was sent). */
  turnsLeft: number | undefined
  /** The owner opened this session to watch it (the core said so in a header). */
  watched: boolean
  /** A failed send that left the chat usable (a busy turn, a network blip). */
  problem: string | undefined
  /** Why the chat could not start or is over: one sentence. */
  endText: string | undefined
  /** Opening again may work (the core was busy, over a cap for now, or unreachable). */
  retryable: boolean
}

export interface GuestChat {
  state: GuestChatState
  send(text: string): void
  /** Ask for a session again after a refusal that may pass. */
  retry(): void
  /** End the session at the core (DELETE) and forget it; resolves when done. Never rejects. */
  leave(): Promise<void>
}

const RETRYABLE = new Set(['busy', 'cap', 'rate-limited', 'unreachable', 'unavailable'])

const INITIAL: GuestChatState = {
  phase: 'opening',
  session: undefined,
  items: [],
  busy: false,
  turnsLeft: undefined,
  watched: false,
  problem: undefined,
  endText: undefined,
  retryable: false,
}

const withBlock = (item: ChatItem, event: GuestChatEvent): ChatItem => {
  if (item.kind !== 'assistant') return item
  const blocks: ChatBlock[] = [...item.blocks]
  if (event.type === 'text') {
    const last = blocks.at(-1)
    if (last?.kind === 'text')
      blocks[blocks.length - 1] = { kind: 'text', text: last.text + event.delta }
    else blocks.push({ kind: 'text', text: event.delta })
  } else if (event.type === 'tool') {
    const at = blocks.findIndex((b) => b.kind === 'tool' && b.call.id === event.id)
    const before = at === -1 ? undefined : blocks[at]
    const call = {
      id: event.id,
      name: event.name !== '' ? event.name : before?.kind === 'tool' ? before.call.name : 'tool',
      state:
        event.state === 'running'
          ? 'input-available'
          : event.state === 'done'
            ? 'output-available'
            : 'output-error',
      input: {},
      ...(event.state === 'error' ? { errorText: 'failed' } : {}),
    }
    if (at === -1) blocks.push({ kind: 'tool', call })
    else blocks[at] = { kind: 'tool', call }
  }
  return { ...item, blocks }
}

/**
 * The state of one guest chat: it opens a session on mount, streams each answer into the conversation and
 * lands every failure in a state with one sentence (client.md, "Guest client"). Nothing is written anywhere: the
 * conversation lives in this hook only and is gone with the screen.
 */
export function useGuestChat(client: GuestClient): GuestChat {
  const [state, setState] = useState<GuestChatState>(INITIAL)
  const stateRef = useRef(state)
  stateRef.current = state
  const counter = useRef(0)
  const alive = useRef(true)
  /** The last message was sent: the core ends the session (turn-cap), the client must not. */
  const capped = useRef(false)
  const patch = useCallback((next: Partial<GuestChatState>) => {
    if (alive.current) setState((cur) => ({ ...cur, ...next }))
  }, [])

  const open = useCallback(async () => {
    patch({ phase: 'opening', endText: undefined, retryable: false })
    try {
      const session = await client.open()
      patch({ phase: 'ready', session, turnsLeft: session.limits.maxTurns })
    } catch (error) {
      if (!(error instanceof GuestError)) throw error
      patch({
        phase: 'refused',
        endText: guestFailureText(error),
        retryable: RETRYABLE.has(error.kind),
      })
    }
  }, [client, patch])

  useEffect(() => {
    alive.current = true
    void open()
    return () => {
      alive.current = false
      // best effort when the screen goes away without `leave()` (ctrl+c): the core's sweeper is the backstop
      void client.end()
    }
  }, [client, open])

  const send = useCallback(
    (text: string) => {
      const cur = stateRef.current
      if (cur.phase !== 'ready' || cur.busy || text.trim() === '') return
      const n = ++counter.current
      const assistantId = `a${n}`
      setState((s) => ({
        ...s,
        busy: true,
        problem: undefined,
        items: [
          ...s.items,
          { id: `u${n}`, kind: 'user', text },
          { id: assistantId, kind: 'assistant', proactive: false, stopped: false, blocks: [] },
        ],
      }))
      const dropEmpty = (items: ChatItem[]): ChatItem[] =>
        items.filter(
          (i) => !(i.id === assistantId && i.kind === 'assistant' && i.blocks.length === 0),
        )
      void (async () => {
        try {
          for await (const event of client.chat(text)) {
            if (!alive.current) return
            if (event.type === 'meta')
              patch({
                turnsLeft: event.turnsLeft,
                watched: event.watched || stateRef.current.watched,
              })
            else if (event.type === 'error')
              setState((s) => ({
                ...s,
                items: [
                  ...dropEmpty(s.items),
                  { id: `n${n}`, kind: 'notice', level: 'error', text: event.text },
                ],
              }))
            else if (event.type === 'text' || event.type === 'tool')
              setState((s) => ({
                ...s,
                items: s.items.map((i) => (i.id === assistantId ? withBlock(i, event) : i)),
              }))
          }
          if (!alive.current) return
          const last = stateRef.current.turnsLeft
          if (last === 0) {
            // the core ends the session itself after its grace, with reason turn-cap (the audit row): say so now,
            // and do not send DELETE, which would make the reason `closed`
            capped.current = true
            patch({ busy: false, phase: 'ended', endText: GUEST_END_TEXT['turn-cap'] })
          } else patch({ busy: false })
        } catch (error) {
          if (!(error instanceof GuestError)) {
            patch({ busy: false, problem: 'The message could not be sent.' })
            return
          }
          setState((s) => ({ ...s, items: dropEmpty(s.items) }))
          if (error.kind === 'ended' || error.kind === 'unauthorized')
            patch({ busy: false, phase: 'ended', endText: guestFailureText(error) })
          else patch({ busy: false, problem: guestFailureText(error) })
        }
      })()
    },
    [client, patch],
  )

  const leave = useCallback(async () => {
    if (capped.current) return
    await client.end()
  }, [client])

  return { state, send, retry: () => void open(), leave }
}
