import { z } from 'zod'

/**
 * Where the text a tool returns comes from (ADR-0036 §3). `trusted`: Keith's own state (tasks, presence, budget, the persona,
 * the person's own style). `outside`: anything a third party can write (web pages, search results, plugin text from other people,
 * room messages, other people's notes, node and desktop output, a worker's report). A tool that declares nothing is `outside`.
 */
export const ToolSourceSchema = z.enum(['trusted', 'outside'])
export type ToolSource = z.infer<typeof ToolSourceSchema>

/** The conversation a risky call is made in (ADR-0036 §2): `clean` when the person's own words asked for it, `tainted` otherwise. */
export const ConsentContextSchema = z.enum(['clean', 'tainted'])
export type ConsentContext = z.infer<typeof ConsentContextSchema>

/**
 * How a waiting call is confirmed (ADR-0036 §4): `conversation` asks in the chat in Keith's own words; `device` goes to the
 * person's trusted clients. A call whose tier is unknown counts as `device`.
 */
export const ConsentTierSchema = z.enum(['conversation', 'device'])
export type ConsentTier = z.infer<typeof ConsentTierSchema>
