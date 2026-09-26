# Canonical scenarios

These scenarios define what Keith must *feel* like. Each one is an acceptance target: the phase that delivers it must include an end-to-end test that plays it out (with a scripted fake LLM where needed). Plans cite scenarios by ID.

| ID | Scenario | Delivered in |
|---|---|---|
| S-1 | Arrival and briefing | Phase 1 (deliveries), phase 2+ (plugin briefing items such as news) |
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

**Test (phase 1):** a Task completes while no node is attached. A node connects after the away threshold and sends "hello". The reply contains the task result, and the delivery is marked delivered.

## S-2 Research in the background, report when done

*"Keith, research venue options for the Expo." "I'll get on it, sir." Tony keeps talking about something else. Later: "Sir, the venue shortlist is ready."*

1. The model calls `task.start({ agent: "researcher", goal, notify: "when-done", promise: "I'll tell you when the shortlist is ready" })`.
2. A Task (background lane) and a Commitment are created. The turn ends quickly.
3. Tony keeps chatting. His turns are never delayed by the Task (I-5).
4. The Task completes, the Commitment is fulfilled, and a Delivery is queued. At the next `idle` moment the Mind runs a proactive turn and the node receives an unsolicited assistant message (I-11).

**Test (phase 1):** covers all four steps with a fake LLM. It asserts that a second user turn issued while the task runs completes before the task, and that the delivery arrives unsolicited.

## S-3 Remembered the next day

*The next morning: "What did you find yesterday about the venues?"*

Phase 1: the Thread's history and the Task result are persisted and available after a core restart. Phase 4: facts are distilled into semantic memories by reflection and recalled with `memory.recall`.

**Test (phase 1):** restart the core between turns. History and task results survive, and the next turn's context includes them.

## S-4 Two people, two conversations, one mind

*Tony asks for work A from his laptop. At the same time Pepper asks for work B from her phone. Keith handles both like a person chatting with two friends.*

- Two direct Threads, two independent LLM contexts, running concurrently in the foreground lane.
- Each Thread's awareness digest knows the Mind is busy elsewhere, without private details (I-3, I-4).
- Each gets their own tone from their own Relationship.

**Test (phase 1):** two Persons created by fixture send inputs at the same time, and both turns stream concurrently. **Test (phase 5):** a memory with `subject` visibility about Tony never appears in Pepper's context.

## S-5 Relay between people

*"Tell Pepper I'll be late." Pepper's phone: "Tony says he'll be late."*

1. The model calls `relay.send({ to: "pepper", text })` in Tony's Thread.
2. The core checks I-13: tier allows, and Pepper's Relationship doesn't block Tony.
3. A Delivery authored by Tony is queued for Pepper's `main` Thread and surfaced with attribution.
4. Pepper can answer ("Tell him no problem"), which relays back the same way.

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

## S-7 Switch device and modality mid-conversation

*Tony types on his laptop, walks off, and speaks into his phone. Keith answers out loud on the phone. The laptop shows the same exchange as text.*

Focus moves to the phone because it sent the latest input. Audio goes only to the focus node, and text goes to every attached node (I-6, I-7).

## S-8 Terminal first, visuals later

*Keith runs with only the TUI. Later the owner enables `@keith/web`. The browser shows the same Threads, and tool results that carry UI blocks now render as cards.*

Nothing in the Mind or in tool plugins changes (I-9, I-12).
