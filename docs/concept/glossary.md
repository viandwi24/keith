# Glossary

One word, one meaning. Use these exact terms in code identifiers, docs and commit messages. Don't use the banned synonyms.

| Term | Meaning | Don't say |
|---|---|---|
| **Mind** | The single continuous awareness of a deployment (I-1) | agent (for the Mind), brain, CEN, DMN |
| **Person** | Someone Keith knows. Has a `tier` | user (in domain code; fine in auth/HTTP code) |
| **Relationship** | The Mind's side of knowing a Person: tier, tone, notes, memories about them, commitments to them | profile, face (informal only) |
| **Tier** | Trust level of a Person: `owner` \| `member` \| `guest` | role (reserved for agents), rank |
| **Thread** | A continuing conversation between the Mind and one or more participants | session, chat, conversation (in identifiers) |
| **Participant** | A Person who belongs to a Thread | member (reserved for the tier) |
| **Direct thread** | A Thread with exactly one participant. Each Person has one called `main` | private chat, DM |
| **Group thread** | A Thread with two or more participants, for collaboration through Keith | room, channel, team chat |
| **Turn** | One cycle in a Thread: input → context → LLM steps → output | request, exchange |
| **Turn state** | `idle` \| `listening` \| `thinking` \| `speaking` | status, mode |
| **Message** | One entry in a Thread's history: role, modality, content | event (reserved), utterance |
| **Modality** | How a message was carried: `text` \| `audio` | protocol, channel, mode |
| **Node** | Any process connected through the public protocol | client (in identifiers), device (in identifiers), adapter |
| **Attended node** | A Node with a signed-in Person | user node |
| **Headless node** | A Node with no Person, exposing machine capabilities only | server node, agent node |
| **Capability** | A versioned feature a Node declares, e.g. `ui.render@1` | feature flag, permission |
| **Focus** | The Node that sent the latest input to a Thread. It receives audio output | active session, primary node |
| **Plugin** | Code running inside the core process to extend it | extension, addon, module (for plugins) |
| **Plugin kind** | `infra` \| `provider` \| `tool` \| `client-app` | type, category |
| **Client app** | A plugin of kind `client-app` that serves or bridges a surface (web, Telegram) | frontend plugin |
| **Service** | A named, typed capability a plugin provides in-process, e.g. `weather` | dependency, contribution |
| **Event** | An immutable fact published on the event bus, named in past tense | message, signal, command |
| **Tool** | A function the model may call during a turn | action, function (in docs) |
| **Skill** | A named instruction bundle loaded into context on demand | prompt (as a registry) |
| **Agent** | A role definition (system prompt + tools + model role) used to run a Task | sub-agent (as a type name) |
| **Task** | Background work run by the Mind for a Person, often with an Agent | job, sub-agent run |
| **Commitment** | A promise made in a Thread, linked to a Task | promise (in identifiers) |
| **Reminder** | A time-based Delivery the person asked for (phase 4) | alarm, timer |
| **Delivery** | A pending item to surface in a Thread (task result, relay, plugin item, invitation) | notification (reserved for OS notifications) |
| **Relay** | A Delivery that carries one Person's message into another Person's Thread | forward, DM |
| **Presence** | Whether a Person has an attended Node open (`present`) or not (`away`) | online status |
| **Arrival** | A Person becoming present after being away longer than the threshold | login, reconnect |
| **Briefing** | A proactive turn on arrival that summarizes pending Deliveries | digest (reserved), summary |
| **Awareness digest** | A short, visibility-filtered summary of what the Mind is busy with elsewhere | shared context |
| **Memory** | A stored fact with subject, visibility and source | knowledge, note |
| **Visibility** | Who may see a memory: `subject` \| `thread` \| `household` \| `owner` | privacy, scope |
| **Provider** | An adapter to an external or local engine: LLM, STT, TTS, VAD, realtime | brain, driver, backend |
| **Model ref** | `<providerId>:<modelId>`, e.g. `deepseek:deepseek-flash` | model name |
| **Model role** | Which model a job uses: `foreground` \| `background` \| `utility` | tier (reserved) |
| **UI block** | A renderer-agnostic UI description from the standard schema | widget, component (in contracts) |
| **Workspace** | The Mind's visual space of windows for a Person or a group thread (planned) | HUD, desktop, canvas |
| **Core** | The single server process: Mind + plugin host + HTTP/WS server | server (in docs, acceptable in code), backend |

## Scoped exceptions

Some banned words have one narrow, allowed meaning. Use them only in these places:

| Word | Allowed only as | Example |
|---|---|---|
| `client` | Software identity in `hello.client`, and the `@keith/client` library (a protocol client used *by* Nodes) | `hello.client.name = "keith-tui"` |
| `role` | LLM message role (`user` / `assistant` / `tool`), and **model role** | `message.role`, `models.foreground` |
| `job` | A unit of work run by the Scheduler (a turn or a task step) | `scheduler.run(lane, job)` |
| `notes` | The free-text field of a Relationship card | `relationship.notes` |
| `user` | HTTP/auth code and LLM message roles | `POST /v1/auth/login` |
