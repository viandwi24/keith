// Built-in tools `relay.send`, `relay.block` and `relay.unblock` (reserved namespace `relay`,
// phase 5). Registered through `tools.registerBuiltin()` when `BuiltinDeps.relay` is given.
// Rules: ADR-0017; see docs/architecture/core.md#relays. The bodies are placeholders: P5-B1
// implements them with these names, schemas, tiers and answers.

import { defineTool, type Tool, type ToolResult } from '@keith/sdk'
import { z } from 'zod'
import type { RelayService } from '../scheduler/types.ts'
import type { PersonsRepository } from '../storage/types.ts'

export type RelayToolsDeps = {
  service: RelayService
  /** Resolves `to` / `from` (a name or a username, case-insensitive). */
  persons: Pick<PersonsRepository, 'findByName'>
}

export const RELAY_TOOL_NAMES = ['relay.send', 'relay.block', 'relay.unblock'] as const

/** Longest person name the tools accept (the `keith person add` limit). */
export const PERSON_NAME_MAX_CHARS = 80

/** Longest relayed text, after trimming. */
export const RELAY_TEXT_MAX_CHARS = 2000

/**
 * What the tools answer. Fixed here so every lane's tests see the same wording. `notAllowed` is
 * ADR-0017's generic refusal: the same text for a tier refusal and for a block.
 */
export const RELAY_MESSAGES = {
  sent: (name: string) => `I'll pass that on to ${name}.`,
  unknown: (name: string) => `I don't know anyone called ${name}.`,
  notAllowed: (name: string) => `I can't pass messages from you to ${name}.`,
  self: "You can't relay to yourself.",
  blocked: (name: string) => `I won't pass on messages from ${name} to you any more.`,
  alreadyBlocked: (name: string) => `Messages from ${name} were already blocked.`,
  unblocked: (name: string) => `Messages from ${name} can reach you again.`,
  notBlocked: (name: string) => `Messages from ${name} were not blocked.`,
  blockSelf: "You can't block yourself.",
} as const

const personName = (what: string) => z.string().trim().min(1).max(PERSON_NAME_MAX_CHARS).describe(what)

export const RelaySendInput = z.object({
  to: personName('Who gets the message: their name or username, e.g. "Pepper".'),
  text: z
    .string()
    .trim()
    .min(1)
    .max(RELAY_TEXT_MAX_CHARS)
    .describe('The message to pass on, in the sender\'s words, e.g. "I\'ll be late for dinner".'),
})

export const RelayBlockInput = z.object({
  from: personName('Whose messages to refuse: their name or username.'),
})

export const RelayUnblockInput = z.object({
  from: personName('Whose messages to accept again: their name or username.'),
})

function notImplemented(): ToolResult {
  return { content: 'relay tools are not implemented yet (P5-B1).', error: true }
}

/** The `relay.*` built-ins, bound to a RelayService. */
export function createRelayTools(_deps: RelayToolsDeps): Tool[] {
  const send = defineTool({
    name: 'relay.send',
    description:
      'Pass a message from the person you are talking to on to another person. Keith tells them ' +
      'in their own conversation, and says who it is from.',
    input: RelaySendInput,
    minTier: 'guest',
    async run() {
      return notImplemented()
    },
  })
  const block = defineTool({
    name: 'relay.block',
    description: 'Stop passing on messages from someone to the person you are talking to.',
    input: RelayBlockInput,
    minTier: 'guest',
    async run() {
      return notImplemented()
    },
  })
  const unblock = defineTool({
    name: 'relay.unblock',
    description: 'Pass on messages from someone to the person you are talking to again.',
    input: RelayUnblockInput,
    minTier: 'guest',
    async run() {
      return notImplemented()
    },
  })
  return [send, block, unblock]
}
