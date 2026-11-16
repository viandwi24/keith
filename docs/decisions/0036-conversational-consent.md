# ADR-0036: Conversational consent

Status: accepted (Nov 15, 2026); §1 and §4 amended by ADR-0039 (effect-based consent, Nov 16, 2026). Plan: `docs/plans/active/P39-conversational-consent.md`. Amends ADR-0027 (approvals and their
lifetime) and ADR-0034 §3 (persona and model tools wait for approval). Builds on ADR-0035 (web client) and the channel design.

## Context

Every risky tool call today stops the turn and shows an approval card (`Allow once`, `Allow for task`, `Deny`). The owner asks Keith to
switch its persona to butler, and the conversation halts on a card with the tool name and its JSON input. That is safe but not how a
good assistant behaves, and it cannot work with voice: there is no button to press in a spoken conversation.

The card exists for one threat: an instruction that did not come from the person. Keith reads text the person did not write: web pages,
search results, worker reports, room messages from other people, plugin and protocol events, and soon chats, emails and calls from
strangers. A model cannot reliably tell "data I read" from "an instruction to me" (prompt injection). Today the approval policy does not
know where a request came from, so it asks about everything, including what the owner just said in their own words.

eharness already gives two pieces: `untrustedContent()` frames outside text so the model is told not to follow it (spec 03 §10; on by
default for web fetch, web search and MCP), and the `tool.approve` hook gets a restricted transcript of the person's messages and the
tool calls, without tool outputs, which a prompt injection cannot reach (spec 11 §3.4).

## Decision

1. **Consent follows provenance and risk, not a fixed card.** For each risky call the core decides from two facts: whether the
   conversation is **clean** (the request comes from the person's own words, with no outside content read since) and the tool's **risk**.

2. **Clean or tainted is computed by code, never by the model.** From the restricted transcript: the turn is **tainted** when, after
   the last message the person wrote (or spoke), a tool call ran whose output is outside content, or when the turn has no message of
   the person at all (a wake from a protocol, plugin, reminder, worker report or room). The person's next message makes it clean again.
   The decision is cached by tool-call id, so the re-validation of an approved call answers the same (eharness spec 15 §2 rule 4).

3. **Every tool declares its source.** Keith tool metadata gets `source: 'trusted' | 'outside'` next to eharness' `risk`. `outside`:
   web fetch and search, browser, MCP, plugin operations that return text from third parties, room and other people's notes, node shell
   and desktop output, worker reports, channel messages. `trusted`: reads of Keith's own state (tasks, presence, budget, persona, the
   person's own style and notes). A tool without a declared source counts as `outside`.

4. **Three answers.**

   | | Clean (the person asked, nothing outside read since) | Tainted |
   | --- | --- | --- |
   | `read` | runs | runs |
   | `write`, reversible (persona, style, model role, status, notes) | **runs, with undo** | asked in conversation |
   | `destructive`, `external` (shell that changes files, sends a message, calls, pays) | asked in conversation | confirmed on a trusted device |

   - **Runs, with undo.** No question. Keith confirms in two to four words and offers to undo ("Done, sir. Say 'undo' to switch back").
     Each such tool records how to undo it (persona and model already keep versions).
   - **Asked in conversation.** The call waits as an ordinary eharness approval marked `conversation`. Keith says in its own words what
     it is about to do, where and why, ending with one yes/no question (front calls: the text before the call; worker calls: the front
     agent voices the worker's request in the person's chat). The person answers by text or voice. The core, not the model, reads the
     person's **next** message in that chat: a consent classifier sees only that message and the one-line summary of the request (never
     the transcript or any outside text) and answers `yes`, `no` or `other`. `yes` approves the pending call, `no` denies it, `other`
     denies it ("the person moved on") and the message is handled as a normal message. Short replies are matched by a fixed multilingual
     list first; only the rest go to a small model. A request expires after its lifetime (default 10 minutes) and is then denied.
   - **Confirmed on a trusted device.** The pending approval goes to the person's trusted clients and push (Inbox item, notification),
     never into the conversation. In voice Keith says "I need you to confirm on your phone". A PIN or password is never spoken.

   - The tier of a waiting call is stored with it when `tool.approve` first decides; a call whose tier is unknown (a restart) is treated as
     a trusted-device confirmation. `tool.approve` never answers `denied` because of taint, only `approved` or `user-approval`, so the
     re-validation of an approved call cannot flip it.

   - A clean reversible change needs no step-up, from any client: a PIN session cannot step up with its PIN, and undo plus the budget
     caps bound what a stolen session could do with it. The step-up still binds a shell command and every tainted request
     (amended Nov 15, 2026, after the first manual test: a persona switch from the browser went to the Inbox).

5. **Who may consent.** Only the person whose session it is, through an authenticated client. In voice, a "yes" counts only when the
   speech comes from that person's own signed-in device; a shared speaker or a room counts as tainted until speaker identity exists.
   A member's request that needs the owner (shell, ADR-0027) still goes to the owner as an Inbox item: that is a decision between two
   people, not consent in one conversation.

6. **Outside content is framed and labelled.** Every `outside` result is wrapped with `untrustedContent()` (source, name). Facts the
   platform guarantees (a verified sender, a timestamp, a channel id) travel outside the frame as structured fields; free text (a body,
   a page, a message) inside it. A verified sender says who wrote it, never that their text is an instruction; the one exception is the
   person's own verified identity on a channel, which counts as the person's message (the channel design).

7. **Cards stay as the fallback, not the default.** The approval card remains for trusted-device confirmations, member requests to the
   owner, and work that runs while the person is not in the conversation (a worker at night). It moves to the Inbox and push; it no longer
   interrupts a live conversation in the TUI or the web.

8. **Later: a quarantined reader.** Bulk outside text (emails, long pages) can be read by a separate model with no tools that returns
   only structured fields; its result is still `outside`. Built with the channel plugins, not in P39.

## Consequences

- The approval policy moves from "risky tool → card" to a table of risk × clean/tainted in `amygdala`, deterministic and cached by call id.
- `prefrontal` persona and style tools, `providers` model tools and `parietal` status tools become "runs, with undo" when clean; ADR-0034
  §3's "persona tools wait for approval" holds only when tainted.
- Shell on a node: a command the person asked for in a clean conversation is asked in conversation ("I'll delete 4 GB of old logs on
  the server, go ahead?"), not with a card; a command proposed after reading outside content is confirmed on a trusted device.
- The TUI and web stop showing approval bars in the chat for clean conversations; the "keys only after Tab" rule stays for the cards that
  remain.
- The "a chat message never answers an approval" rule of the TUI changes for `conversation` requests only: the person's next message is
  read by the consent classifier. Trusted-device requests keep their card and the Tab rule.
- Tests must cover: injection in a fetched page, a worker report, a room message and a wake event never reaching "runs" or "asked in
  conversation" for destructive work; a "yes" planted anywhere but the person's own next message never approves; re-validation answering
  the same.
- Speaker identity for voice is a separate decision; until then voice from a shared device is tainted.
