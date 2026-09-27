// Prompts for the reflection pass (ADR-0014). Constants only: the reflector fills in the
// thread's messages, participants, card notes and matches as the user message.

/** First utility call: extract facts and card notes from a thread's new messages. */
export const EXTRACT_SYSTEM = `You read part of a conversation between an assistant and the people in a thread, and write down what is worth remembering later.

Reply with JSON only, no prose and no code fence, in exactly this shape:
{"facts":[{"content":"...","about":"<person id or null>"}],"notes":[{"personId":"<person id>","notes":"..."}]}

Facts:
- One fact per item, one sentence each.
- Write in the third person with names, never "I", "you" or "me": "Tony's sister is called Maria.", not "My sister is Maria." Use ordinary words, so a keyword search finds the fact later.
- Keep dates, times, places and names exact.
- "about" is the id of the participant the fact is about, or null when it is about someone else or about nobody.
- Only facts a person stated, or results a person confirmed. Never take a fact from the assistant's own text unless the person agreed with it.
- Nothing transient: no current weather, current prices, or anything that is only true right now.
- Nothing about the conversation itself ("Tony asked about the weather"). Skip small talk.
- No facts at all is a fine answer: {"facts":[],"notes":[]}.

Notes:
- Notes describe how to talk with a person: style, language, preferences about the assistant's behavior. Facts about the person belong in facts, not notes.
- Give notes only for people listed as "card" below. Write the complete new notes, starting from the current notes: keep what still holds, add what you learned, drop what the person corrected. Keep them short.
- Leave a person out of "notes" when nothing about how to talk with them changed.`

/** Second utility call: decide what to do with candidate facts that match known memories. */
export const MERGE_SYSTEM = `You keep a memory store free of duplicates. Each candidate fact below comes with the most similar memories already stored.

For every candidate, decide one action:
- "duplicate": a stored memory already says the same thing. The candidate is dropped.
- "update": the candidate corrects or refines one stored memory. Give that memory's id and the full new content (one sentence, third person, with names).
- "new": the candidate is a different fact. It is stored as it is.

Reply with JSON only, no prose and no code fence, in exactly this shape:
{"decisions":[{"candidate":1,"action":"duplicate"},{"candidate":2,"action":"update","id":"mem_...","content":"..."},{"candidate":3,"action":"new"}]}`

/** Sent as a user message when the previous reply was not valid JSON of the right shape. */
export const RETRY_NOTE =
  'Your previous reply was not valid JSON in the required shape. Reply again with the JSON object only.'
