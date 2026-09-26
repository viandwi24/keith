# The concept model

This is the most important document in the repository. Every other doc derives from it. If a design cannot be explained with the terms here, the design is wrong or this document needs an ADR.

## Core terms

```
                    ┌──────────────────────────── Mind (exactly one) ───────────────────────────┐
                    │ identity · persona · memory · scheduler · registries (tools, skills, ...) │
                    │                                                                           │
                    │   Relationship(Tony)            Relationship(Pepper)                      │
                    │     └─ Thread "main" ◄──┐         └─ Thread "main" ◄──┐                    │
                    │                         │                             │      Tasks (bg)    │
                    └─────────────────────────┼─────────────────────────────┼──────────────────-─┘
                                              │ protocol                    │ protocol
                                   Node: TUI (laptop)            Node: web (phone)      Node: system (headless)
```

### Mind

The single continuous awareness of a deployment.

- Owns **identity** (name, persona), **memory**, the **scheduler**, and the **registries** that plugins fill.
- There is exactly one Mind per deployment. It is never duplicated per person, per node or per thread.
- The Mind is *not* one LLM context. It is the state and machinery around LLM calls. Each LLM call is one act of the Mind, made on behalf of one Thread or Task.

### Person and Relationship

A **Person** is someone Keith knows: the owner, a member, a guest. A **Relationship** is the Mind's side of knowing that person, the "face" Keith shows them:

- trust **tier** (`owner`, `member`, `guest`)
- **tone** and relationship notes (how to talk to this person)
- **memories about** this person, each with a visibility
- **commitments** made to this person

Two people get two different faces because they have two Relationships, not two Minds.

### Thread

A continuing conversation between the Mind and one or more **participants** (Persons).

- Each Thread has its own short-term context: recent messages, a running summary, and a turn state.
- Each Thread gets its **own LLM context** for every turn. Parallel Threads never share one context window.
- Threads share the Mind: persona, memory (filtered by visibility), tools, and an **awareness digest** that tells a Thread what else the Mind is busy with, to the extent visibility allows.
- A Thread has one turn state: `idle → listening → thinking → speaking → idle`.
- A **direct thread** has one participant. Each Person has one long-lived direct Thread (`main`).
- A **group thread** has two or more participants. It is how people collaborate *through* Keith, like Tony on a mission with Pepper and Rhodey connected. Group threads ship in phase 5, but the data model and protocol carry participants and message authors from phase 1.

### Presence and arrival

The Mind knows whether each Person is **present** (at least one attended Node open to one of their Threads) or **away**. When a Person returns after being away longer than a threshold, that is an **arrival**. On arrival the Mind may speak first with a **briefing**: deliveries that piled up, tasks that finished, and anything plugins contributed (news, weather, calendar). Briefings are a proactive turn like any other (I-11).

### Relay

The Mind can carry a message from one Person's Thread into another Person's Thread ("Tell Pepper I'll be late"). A relay is a Delivery with an author. It is the lightweight form of collaboration and needs no group thread.

### Node

Any process connected to the core through the public protocol. TUI, web browser, mobile app, desktop app, and headless system agent are all Nodes.

- A Node declares **capabilities** on connect (`chat.text@1`, `audio.in@1`, `ui.render@1`, `fs@1`, ...).
- A Node is **attended** (a Person has signed in through it) or **headless** (it only exposes machine capabilities).
- Many Nodes can attach to one Thread at the same time. The Node that sent the latest input holds the **focus**.

### Plugin

Code that runs **inside the core process** to extend it. A thing is a plugin if and only if it needs code running in the core. Otherwise it is a Node.

Plugin kinds: `infra`, `provider`, `tool`, `client-app`. See [`../architecture/plugin-system.md`](../architecture/plugin-system.md).

### Task

Work the Mind does when nobody is waiting for it: a sub-agent run, a reflection pass, a scheduled check. A Task may be linked to a **Commitment**, which is a promise made in a Thread ("I'll tell you when it's done"). When a Task completes, a **Delivery** carries the result back into the Thread.

## Invariants

These are testable. Each has an ID so code, tests and ADRs can cite it.

| ID | Invariant |
|---|---|
| **I-1** | There is exactly one Mind per deployment. |
| **I-2** | Every Thread has one or more participants. Every message records its author (a Person, or the Mind). |
| **I-3** | Every LLM call is made on behalf of exactly one Thread or one Task. Its context holds only what **every** participant of that Thread (or the Task's Person) may see. |
| **I-4** | A memory is visible in a Thread only if its visibility rule admits **all** of that Thread's participants (see [memory.md](../architecture/memory.md)). |
| **I-5** | A human waiting in a Thread always has priority over background work. Background work never takes foreground capacity. |
| **I-6** | Text and audio are properties of a message (`modality`), never of a connection or a session. |
| **I-7** | Text and UI output go to every Node attached to the Thread. Audio output goes only to the focus Node. |
| **I-8** | Every Node, including the web client, reaches the Mind through the same public protocol. No Node has a private back door. |
| **I-9** | Plugins that produce UI describe it with the UI block schema. They never know which client renders it. |
| **I-10** | A Commitment made in a Thread is fulfilled, cancelled or expired. It is never silently dropped. |
| **I-11** | Clients must accept assistant messages they did not ask for. The Mind can speak first. |
| **I-12** | The core runs fully with no client-app plugins installed (terminal only). |
| **I-13** | A relay into another Person's Thread happens only if the sender's tier allows it and the recipient's Relationship does not block it. The recipient always sees who it came from. |

The canonical scenarios that exercise these invariants are in [scenarios.md](scenarios.md).

## Walkthrough: Tony and Pepper at the same time

1. Tony types in the TUI on his laptop: "Research the Stark Expo venue options, let me know when done."
2. Tony's Thread moves to `thinking`. The turn loop builds a context from Keith's persona, Tony's relationship card, visible memories, and recent messages in Tony's Thread. The model calls `task.start` with `notify: when-done`, which creates a **Task** and a **Commitment**. Keith replies, "On it. I'll tell you when I have a shortlist." Tony's Thread goes back to `idle`.
3. Pepper opens the web app on her phone and speaks. Her Thread gets its own context: persona, *Pepper's* relationship card, memories visible to Pepper, *her* recent messages. Its awareness digest says Keith is running a research task for another household member, with no details, because the Task's visibility is private to Tony.
4. The Task runs in the background lane. It never delays Pepper's replies (I-5).
5. The Task completes. The Commitment matches, and a **Delivery** is queued for Tony's Thread. Tony's Thread is `idle`, so the Mind runs a short proactive turn and Tony's TUI receives an unsolicited message (I-11): "The venue shortlist is ready…"
6. Pepper asks, "What is Tony working on?" Her Thread can only see memories whose visibility admits her (I-4). Keith answers within those limits.

## What this model deliberately removes (from Kehai)

| Removed | Replaced by |
|---|---|
| A CEN + DMN agent pair per user | One Mind. Relationship = face. Scheduler lanes = foreground vs background |
| Session "communication protocols" (`chat` vs `voice`) | `modality` per message (I-6) |
| One active session per user + explicit takeover | Focus = the node that sent the latest input (I-7) |
| Client vs Node as separate concepts | Everything outside the core is a Node |
| Plugins declaring `depends` on other plugins | Services (requests) and events (facts) |
