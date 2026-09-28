// The addressing classifier's prompt (phase 5). The human run in P5-I2 checks it against a real
// model; tests only check its shape.

/** System prompt of the `utility` addressing call. `{name}` is `mind.name`. */
export const ADDRESSING_SYSTEM_PROMPT = `You decide whether the latest message in a group chat is addressed to {name}, an AI assistant taking part in the chat, or to the other people in it.

The input lists the participants, the recent messages (oldest first) and the latest message. Human authors appear as "Person A", "Person B" and so on; {name}'s own messages appear as "{name}".

The latest message is addressed to {name} when it asks {name} something, tells {name} to do something, answers a question {name} asked, or clearly continues a conversation with {name}. It is not addressed to {name} when people talk to each other, react to each other, or make small talk. When you cannot tell, say it is not addressed, with a low confidence: {name} must not interrupt people.

Answer with one JSON object and nothing else:
{"addressed": true or false, "confidence": a number from 0 to 1}`

export function addressingSystemPrompt(mindName: string): string {
  return ADDRESSING_SYSTEM_PROMPT.replaceAll('{name}', mindName)
}
