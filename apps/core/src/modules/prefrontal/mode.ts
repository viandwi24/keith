// The answer mode of a turn, chosen in code from the channel's declared rendering ids and the kind of request (docs/specs/prefrontal.md
// "Modes"; ADR-0029 §5). The model never picks it. A client that declares neither render id gets plain text in `chat`.
import type { ClientRecord } from '@keith/contracts'

export type AnswerMode = 'speech' | 'chat' | 'report'
/** `report`: a worker or protocol result. `chat`: anything a person says. */
export type RequestKind = 'chat' | 'report'

/** The rendering ids a channel declared (only the ids matter here). */
export interface ChannelView {
  readonly capabilities: readonly string[]
}

export interface ModeInput {
  requestKind: RequestKind
  /** The channel the answer goes through; undefined when no client of the person is online to say. */
  channel: ChannelView | undefined
  /** A second, Markdown-rendering screen of the person is online (it shows the detail of a spoken answer). */
  hasScreen: boolean
}

export interface ModeChoice {
  mode: AnswerMode
  /** No Markdown: the channel does not declare `render.markdown`, or it is spoken. */
  plain: boolean
  /** The channel is spoken (`render.speech-only`): the speakable guard flattens the answer, whatever the mode. */
  speech: boolean
  /** The detail goes to the second screen (`speech` only). */
  screen: boolean
}

/**
 * The mode of one answer (the table of P33 "Modes"). A speech channel is `speech`, except a worker or protocol report, which is
 * `report` whatever the channel (the report block carries the conclusion rule); a report on a speech channel still gets the
 * speakable guard. A channel that declares `render.markdown` is `chat` with Markdown allowed; one that declares neither is
 * `chat` in plain text.
 */
export function chooseMode(input: ModeInput): ModeChoice {
  const ids = input.channel?.capabilities ?? []
  const speech = ids.includes('render.speech-only')
  const markdown = ids.includes('render.markdown')
  if (speech) {
    return {
      mode: input.requestKind === 'report' ? 'report' : 'speech',
      plain: true,
      speech: true,
      screen: input.hasScreen,
    }
  }
  return {
    mode: input.requestKind === 'report' ? 'report' : 'chat',
    plain: !markdown,
    speech: false,
    screen: false,
  }
}

/**
 * The channel of a person's turn: the online client that was active most recently (`lastActiveAt`, else `lastSeenAt`). The second
 * screen is another online client that renders Markdown. A read of the client list only; nothing is written.
 */
export function pickChannel(clients: readonly ClientRecord[]): {
  channel: ChannelView | undefined
  hasScreen: boolean
} {
  const online = clients.filter((c) => c.online)
  const at = (c: ClientRecord): number => c.lastActiveAt ?? c.lastSeenAt
  let channel: ClientRecord | undefined
  for (const c of online) if (channel === undefined || at(c) > at(channel)) channel = c
  const hasScreen = online.some((c) => c !== channel && c.capabilities.includes('render.markdown'))
  return {
    channel: channel === undefined ? undefined : { capabilities: channel.capabilities },
    hasScreen,
  }
}

/** The mode of a turn of one person, from that person's clients only. */
export function modeForClients(
  clients: readonly ClientRecord[],
  requestKind: RequestKind = 'chat',
): ModeChoice {
  const { channel, hasScreen } = pickChannel(clients)
  return chooseMode({ requestKind, channel, hasScreen })
}
