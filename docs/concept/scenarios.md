# Canonical scenarios

These scenarios define what Keith must *feel* like. Each one is an acceptance target: the phase that delivers it must include an end-to-end test that plays it out (with a scripted fake LLM where needed). Plans cite scenarios by ID.

| ID | Scenario | Delivered in |
|---|---|---|
| S-1 | Arrival and briefing | Phase 1 (deliveries), phase 2+ (plugin briefing items such as news), phase 4 (reminders, briefing skill) |
| S-2 | Research in the background, report when done | Phase 1 |
| S-3 | Remembered the next day | Phase 1 (history), phase 4 (semantic memory) |
| S-4 | Two people, two conversations, one mind | Phase 1 (concurrency), phase 5 (tiers + visibility) |
| S-5 | Relay between people | Phase 5 |
| S-6 | Collaboration: a group thread with shared state | Phase 5 (group thread), phase 6 (shared workspace) |
| S-7 | Switch device and modality mid-conversation | Phase 3 |
| S-8 | Terminal first, visuals later | Phase 2 |

---

## S-1 Arrival and briefing

*Tony walks into the lab after a night's sleep. "Hello Keith." "Good morning, sir." What did he miss? Or Keith speaks first, because Tony has been away for hours.*

1. Tony's TUI connects and opens his `main` Thread. He was away longer than `mind.arrival.awayAfterMinutes`, so the core emits `person.arrived`.
2. Plugins listening to `person.arrived` may enqueue Deliveries (a news plugin enqueues "3 headlines", a weather plugin enqueues "rain at 4pm").
3. Depending on `mind.arrival.briefing`:
   - `auto`: the Mind runs a **briefing turn** right away and greets him, summarizing pending Deliveries (finished tasks, relays, plugin items) in order of urgency.
   - `on-greeting` (default): the Mind waits for his first input (up to a hold timeout). If that input is a greeting or "what did I miss", the reply leads with the briefing. Otherwise Keith answers first and then briefly mentions what's pending. If he says nothing for a while, Keith delivers the items on its own.
   - `off`: Deliveries flush normally, one by one.
4. Deliveries included in a briefing are marked delivered. None is dropped (I-10).

**Test (phase 1):** a Task completes while no node is attached. A node connects after the away threshold and sends "hello". The reply contains the task result, and the delivery is marked delivered. A second test sends a first input that is not a greeting: the reply answers it first, then mentions the result, and no separate delivery turn follows.

**Test (phase 4, reminders):** `tests/e2e/s1-reminder.test.ts`. On day 1 Tony asks for a reminder at 09:00 the next day; the model calls `reminder.set` with an `at` without an offset, which is read in `mind.timezone`. The core restarts overnight. If Tony is attached, the first tick after 09:00 turns the reminder into a `high` delivery, and he gets it as an unsolicited message (a tick before 09:00 fires nothing). With `briefing = "auto"` and Tony arriving at 09:30, the briefing turn carries the reminder, its context offers the `morning_briefing` skill, and the delivery is marked delivered. CI runs it five times in a row.

## S-2 Research in the background, report when done

*"Keith, research venue options for the Expo." "I'll get on it, sir." Tony keeps talking about something else. Later: "Sir, the venue shortlist is ready."*

1. The model calls `task.start({ goal, notify: "when-done", promise: "I'll tell you when the shortlist is ready" })`. Without `agent` the Task runs the built-in `general` agent; a plugin may register a more specific one (e.g. a researcher).
2. A Task (background lane) and a Commitment are created. The turn ends quickly.
3. Tony keeps chatting. His turns are never delayed by the Task (I-5).
4. The Task completes, the Commitment is fulfilled, and a Delivery is queued. At the next `idle` moment the Mind runs a proactive turn and the node receives an unsolicited assistant message (I-11).

**Test (phase 1):** covers all four steps with a fake LLM. It asserts that a second user turn issued while the task runs completes before the task, and that the delivery arrives unsolicited.

## S-3 Remembered the next day

*The next morning: "What did you find yesterday about the venues?"*

Phase 1: the Thread's history and the Task result are persisted and available after a core restart. Phase 4: facts are distilled into semantic memories by reflection and recalled with `memory.recall`.

**Test (phase 1):** restart the core between turns. History and task results survive, and the next turn's context includes them.

**Test (phase 4, integration):** on the real core with a scripted utility model, a thread that has been idle past `memory.reflect.idleMinutes` is reflected on the next scheduler tick: the utility model gets that thread's messages, an `inferred` memory is stored and `memory.reflected` is emitted. A thread longer than `recentMessages + minMessages` gets a summary, and the next turn's system prompt holds `# Earlier in this thread`. A home the core wrote (stated and inferred memories, a pending reminder) survives `keith backup` / `keith restore` into a new home.

**Test (phase 4, end to end):** `tests/e2e/s3-semantic.test.ts` runs the real core with a scripted chat model, a separate scripted utility model and the fake clock, with `recentMessages = 4` and thread summaries off, so only semantic memory can carry the fact. On day 1 Tony says "my sister Maria lands in Surabaya on Friday", and three more exchanges push that message out of the window. Past `memory.reflect.idleMinutes`, a tick runs reflection: the utility model returns the fact, and a `subject`, `inferred` memory about Tony is stored and `memory.reflected` is emitted. The core restarts on the same home 20 hours later. Tony asks "When does my sister arrive?": neither the system prompt nor any message of the model's request holds the day-1 text, the model calls `memory.recall`, the result it gets back holds the reflected fact, and the answer is stored. Pepper (a member) asks the same in her own thread, and her `memory.recall` finds nothing (I-4). CI runs it five times in a row.

## S-4 Two people, two conversations, one mind

*Tony asks for work A from his laptop. At the same time Pepper asks for work B from her phone. Keith handles both like a person chatting with two friends.*

- Two direct Threads, two independent LLM contexts, running concurrently in the foreground lane.
- Each Thread's awareness digest knows the Mind is busy elsewhere, without private details (I-3, I-4).
- Each gets their own tone from their own Relationship.

**Test (phase 1):** two Persons created by fixture send inputs at the same time, and both turns stream concurrently. **Test (phase 5):** a memory with `subject` visibility about Tony never appears in Pepper's context.

**Test (phase 5, integration):** `packages/core/test/people.test.ts` on the real core and storage. `keith person add Pepper` runs next to a running Keith and prints an invite link; `POST /v1/auth/invite` with its code signs her in once (a second use is `401`), into the main thread the command created. `keith person tier Pepper guest` while Keith runs takes effect on her next turn: her tool list loses the `member` tools (`reminder.*`, `thread.start_group`, `thread.invite`) without a restart. `keith person remove Pepper` refuses while Keith runs; with Keith stopped it deletes her direct thread, the memories about her, her tokens and her own messages in a group, and after a restart Tony still opens that group without her line. `packages/core/src/memory/audit.test.ts` checks every read path (recall, core, index, the memory and task tools, the digest) for four people, direct and group threads, and a participant who left through `threads.removeParticipant`.

**Test (phase 5, end to end):** `tests/e2e/s4-privacy.test.ts` runs the real core with nodes over HTTP and WebSocket, a routed `fake:chat` and the fake clock. Pepper (member) and Happy (guest) sign up through `POST /v1/auth/invite` with codes from `keith person add`'s code path. Tony tells Keith a private fact: his model stores it with `memory.remember` (`subject`, pinned) and starts a background task that stays running. Pepper and Happy ask about it in their own threads, and each model tries `memory.recall`. No request built for them (system prompt, messages, tool results) holds the fact, Tony's words or the task's goal, and both recalls find nothing. Pepper's digest is "Busy with 1 private background task for someone else.", Happy's is counts only, and Happy's tool list has no `member` tools (`task.*`, `reminder.*`, `thread.start_group`, `thread.invite`). Tony's own next turn has the fact and the task in detail, and the task's result reaches only his node. CI runs it five times in a row.

## S-5 Relay between people

*"Tell Pepper I'll be late." Pepper's phone: "Tony says he'll be late."*

1. The model calls `relay.send({ to: "pepper", text })` in Tony's Thread.
2. The core checks I-13: tier allows, and Pepper's Relationship doesn't block Tony.
3. A Delivery authored by Tony is queued for Pepper's `main` Thread and surfaced with attribution.
4. Pepper can answer ("Tell him no problem"), which relays back the same way.

**Test (phase 5, integration):** `packages/core/test/relay.test.ts` on the real core. Tony's model calls `relay.send({ to: "pepper" })`. Pepper's attached node gets a proactive delivery turn: its context labels the item `(relay from Tony)` and says to name the sender, and its `message.completed` has `meta.relayFrom` = Tony. After Pepper's model calls `relay.block({ from: "Tony" })`, Tony's next relay answers the generic refusal and enqueues nothing.

**Test (phase 5, end to end):** `tests/e2e/s5-relay.test.ts`, over HTTP and WebSocket, with Tony (owner), Pepper (member, on a web-like node with `chat.text@1` and `ui.render@1`), Rhodey (member) and Happy (guest), the last three signed up through invite codes. "Tell Pepper I'll be late." makes Tony's model call `relay.send`; Pepper's node gets an unsolicited (`proactive`) message whose `meta.relayFrom` is Tony, and the delivery is `delivered` with that message's id. "Tell him no problem" relays back to Tony the same way. Pepper blocks Rhodey (`relay.block`): Rhodey's relay gets the generic refusal and Pepper gets nothing. Happy → Pepper gets the same refusal, and Happy → Tony goes through. With Pepper away (her node closed, past `awayAfterMinutes`), Tony's relay stays `pending` with no turn; when she comes back, her greeting's reply carries it with `meta.relayFrom`, and it is marked delivered (I-11). CI runs it five times in a row.

## S-6 Collaboration: a group thread with shared state

*Mid-mission, Tony says "Connect me with Pepper and Rhodey." All three talk through Keith. Keith shares the mission state with everyone and still keeps each person's private context private.*

1. The model calls `thread.start_group({ participants: ["pepper", "rhodey"], title: "Mission", purpose })` from Tony's direct Thread.
2. Pepper and Rhodey each receive an invitation Delivery in their direct Threads. On accept (or auto-join, if config and tier allow), they become participants.
3. In the group Thread:
   - Every message has an author. Human-to-human messages reach all attached nodes without triggering an LLM turn.
   - The Mind takes a turn when it is **addressed** (by name, by a question to it, or by a reply to its message) or when something it owns changes (a task it started for the group finishes).
   - The context contains the persona, the relationship cards of all participants, and only memories visible to **all** participants (I-4).
   - Memories written in the group get visibility `thread`: shared with that group's participants and nobody else.
   - Tasks started in the group report back to the group.
4. The direct Threads keep running in parallel. Tony can ask Keith something privately while the mission thread is live. His awareness digest includes the group thread.
5. Phase 6: the group Thread owns a **shared workspace**. Everyone whose node has `workspace@1` sees the same windows (map, status board, feeds).

**Hard parts, decided up front:**
- **Addressing.** A rule-based detector (name mention, reply-to, direct question) runs first. A `utility`-model classifier is the fallback. When unsure, the Mind does not interrupt humans.
- **Tone.** In a group, the Mind uses the most formal tone among participants unless it is addressing one person.
- **Leaving.** A participant who leaves keeps the history up to that point. Memories with `thread` visibility stay readable to the remaining participants.

**Test (phase 5, integration):** `packages/core/test/groups.test.ts` on the real core, with `fake:chat` and `fake:utility`. Tony's model calls `thread.start_group`; his node gets `thread.updated` for the new group, and Pepper and Rhodey each get an invitation delivery with Join / Decline. A Join click becomes `(clicked: Join)`, their model calls `thread.join`, and every participant's node gets `thread.updated`. In the group, Pepper and Rhodey talking to each other ("Rhodey, …", "Pepper, …") makes no chat request; "Keith, status?" makes one, whose user messages carry each author's `name`. A line the rules are unsure about asks `fake:utility` once, and its "no" makes no turn. Rhodey leaves: his node gets `thread.removed`, and his `thread.open` and input for the group are `FORBIDDEN`, while the others see him in `formerParticipants`. Tony invites him back, and after joining he sees the whole history.

**Test (phase 5, end to end):** `tests/e2e/s6-group.test.ts`, over HTTP and WebSocket. Tony (two nodes) says "Connect me with Pepper and Rhodey, mission thread.": his model calls `thread.start_group`, both his nodes get `thread.updated`, and Pepper and Rhodey get invitation deliveries (their own `thread.updated` comes when they join). Pepper clicks Join on the card (her web-like node gets it as `ui.render`), Rhodey says "Yes, join." in text, and every node of all three gets `thread.updated` with three participants. In the group, Pepper → Rhodey lines reach every other attached node with no model call. "Keith, what's our status?" runs one turn whose request has every participant's card and tone, the tone rule and each author's `name`. While that turn is still running, Tony asks Keith something privately in his direct thread: his digest says Keith is replying in "Mission", and Pepper's and Rhodey's nodes see nothing of the aside. An unsure line asks `fake:utility` once and makes no turn. Rhodey's model calls `memory.remember` in the group: the memory is `thread`, absent from Happy's (a guest in no group) direct context and present in Pepper's, because she is a current participant (memory.md "In group threads"). A task started in the group reports back to the group as a proactive message on every node. Pepper's web app, in Chromium, lists the group in its sidebar and shows authors' names (skipped with a logged reason when no browser is available). Rhodey leaves: his node gets `thread.removed`, Tony and Pepper see him in `formerParticipants` and keep the whole history, the group's next turn still has the memory, and Rhodey's direct context no longer does. CI runs it five times in a row.

## S-7 Switch device and modality mid-conversation

*Tony types on his laptop, walks off, and speaks into his phone. Keith answers out loud on the phone. The laptop shows the same exchange as text.*

Focus moves to the phone because it sent the latest input. Audio goes only to the focus node, and text goes to every attached node (I-6, I-7).

## S-8 Terminal first, visuals later

*Keith runs with only the TUI. Later the owner enables `@keith/web`. The browser shows the same Threads, and tool results that carry UI blocks now render as cards.*

Nothing in the Mind or in tool plugins changes (I-9, I-12).

**Test (phase 2):** Keith runs TUI-only and a turn produces a weather card. The owner enables `@keith/web` and restarts Keith on the same home. The browser shows the same Thread with the card from history, and the card's Refresh button adds an updated card. The TUI node gets the text and the fallback, never `ui.render`.
