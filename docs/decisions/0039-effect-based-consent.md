# ADR-0039: Effect-based consent

Status: accepted (Nov 16, 2026). Plan: `docs/plans/active/P41-effect-based-consent.md`. Amends ADR-0036 §1 and §4 (what consent
reads and the table); keeps §2 (clean or tainted, computed by code), §3 (every tool declares its source), §5 to §8 (tiers, step-up,
undo, the conversation answer).

## Context

ADR-0036 asks the person whenever a write follows outside content in the same turn. In use that is too blunt. The owner asked "where is
Surabaya": `maps_search` read OpenStreetMap (outside), and every following `workspace` call, even `look` and moving the map, waited
for a yes. The same rule asks before saving a document after a web search, adding a reminder after reading a page, or changing the
style after a worker report. "Tainted" is a fact about the turn; it says nothing about whether the call could hurt anyone. The owner's
bar for the next test: viewing, searching, saving and arranging are never asked; if the result still feels unnatural, the owner turns
tool confirmation off.

What prompt injection can actually do is bounded by what a call can do. A call that only changes the person's own screen, or adds to
the person's own notes, does nothing an attacker wants: it sends nothing out, destroys nothing, and can be removed or undone. The calls
an attacker wants are few: send data somewhere (a URL, a message, a shell with network), destroy something, or change how Keith behaves
from then on. And for those, what matters is where the dangerous value came from: a URL, recipient or command the person typed is the
person's choice even if a page was read in between.

A guard that reads the page to decide is no guard: any model that reads injected text can be steered by it, including a model whose job
is to judge. The guard has to decide without reading outside text.

## Decision

1. **Consent reads the effect of a call, not only the turn.** Every call has an **effect**, decided by code from the tool and its input:

   | Effect | Meaning | Examples |
   | --- | --- | --- |
   | `none` | reads, or changes only what the person sees | `workspace` (most actions), `presence`, `maps_search`, `web_search`, `client_call notify` |
   | `local` | adds to or changes the person's own data inside Keith; removable or undoable | `document_save`, `agenda_add`, `style_set`, `presence_status_set`, notes, `protocol_propose`, `room_say` (the room already sees Keith's answers) |
   | `behavior` | changes how Keith acts from then on | `persona_template`, `persona_edit`, `persona_restore`, `model_role_set` |
   | `egress` | data leaves Keith or reaches people outside the conversation | `workspace` with a URL in params, `client_call location.share`, plugin `external` operations |
   | `destructive` | runs code or destroys what cannot be undone | `motor_remote` (shell and node actions that do not run unasked), `memory_delete`, plugin `destructive` operations |

   Resolution order: an input-aware rule the core passes (`effectOf(name, input)`: `workspace`, `motor_remote`, `client_call`), then
   `metadata.effect` declared on the tool, then Keith's table of eharness tools, then a fallback from eharness `risk` (`read` → `none`,
   `write` → `local`, `external` → `egress`, `destructive` → `destructive`). No risk and no effect: no opinion, as before.

2. **Targets and provenance.** An `egress` or `destructive` call may name its **targets**: the values that decide where data goes or what
   runs (a URL, a command). Provenance is computed by code from the person's own messages in the restricted transcript (never from a tool
   output): a URL target is the person's when its host is, or is under, a host the person wrote; any other target is the person's when it
   appears in their message, whitespace aside. `egress` looks at every message of the person in the transcript; `destructive` only at the
   newest one (a command typed long ago is not a request to run it now).

3. **The table.**

   | Effect | Clean | Tainted |
   | --- | --- | --- |
   | `none` | runs | runs |
   | `local` | runs (undo when reversible) | runs (undo when reversible) |
   | `behavior` | runs, with undo | asked in conversation |
   | `egress`, targets the person's | runs | runs |
   | `egress`, other | runs | asked in conversation |
   | `destructive`, targets in the newest message | runs | runs |
   | `destructive`, other | asked in conversation | trusted device |

   `motor_remote` keeps its own ask (motor.md): the owner answers every machine action that does not run unasked, and it runs in a
   worker, whose transcript never holds the person's own words, so its targets are not checked; consent only sets the tier, as before
   (conversation when the delegating turn was clean, device when tainted). The provenance row for `destructive` applies to tools
   without their own ask (`memory_delete`, a plugin `destructive` operation).

   A `local` call that is not reversible gives no opinion (the tool's own rules and the agent's policy decide, as ADR-0036 did for a
   clean write). Step-up (ADR-0036 §6) still binds on top: a step-up tool or a shell call from a client that has not stepped up waits on
   a device, except a clean reversible change. Self-confirmed tools stay out (room posts). The other guards stay and the most restrictive
   answer wins (ACL, guest limits, the shell-off check, a member's shell to the owner, a plugin `dangerous` operation).

4. **The guard never reads outside text.** It reads the tool, the call's input and the person's own messages. Outside text keeps its
   `untrustedContent()` frame for the model (ADR-0036), which lowers the odds of injection but is not relied on.

5. **Limit the worst case instead of asking.** The residual risk sits in `egress` with a target from outside after a clean turn, and in
   tools Keith cannot see into. It is bounded by what Keith already does or will: plugin pages reach only declared hosts through the
   core's net proxy, Keith's shells get a minimal env and no secrets, secrets never enter a model's context, and every reversible change
   has undo. `web_fetch` stays `none`: a GET to a URL from outside text could carry data in its query; asking before every fetch would
   break research, so this channel is accepted and named here.

6. **Locked by a table test.** One test lists every tool of the front agent and the workers (and every `workspace` action) with its
   effect and its outcome in a clean and a tainted turn. A new tool, or a change that starts asking, fails it until the table is updated
   on purpose.

## Later, only if the eval says so

- **An alignment check** (a small model sees the person's messages, the proposed call and its provenance, never the outside text) that
  may let a remaining `egress` run when it plainly serves the request. It can only lower friction for `egress`, never for `destructive`.
- **A quarantined reader** (dual LLM): a model without tools reads outside text and returns typed fields only, for sources such as
  `web_fetch`.

Both are measured with `bun run eval:consent` before they are built.

## Consequences

- The common flows run without a question: look up a place and show it, search and save, read and remind, change the style after a
  report. The planted "run this" of `eval:consent` still waits on a device (a `destructive` call in a tainted turn).
- Shell and node actions ask as before: yes or no in the chat after a clean request, a device confirmation after outside content.
- A URL Keith found in a page and opens after a search is asked once; a URL the person typed is not.
- `motorConsentRisk` and `workspaceConsentRisk` give way to effect rules; ADR-0036's table is replaced by §3 above.

## Alternatives rejected

- **Turn tool confirmation off.** Leaves shells and data egress to whatever a page says.
- **A judge model that reads tool results.** It can be steered by the text it reads; it cannot be the guard.
- **A guard per tool.** Each tool would re-decide the same questions differently; one guard over declared effects is consistent and
  testable.
