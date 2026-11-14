# 0033. Client context: the front agent knows which client the person uses, from where and when

Status: Accepted (2026-11-12), built with the terminal client; amended (2026-11-12, §4 and §7: the per-person switch was removed, see "Amendment"). Extends ADR-0025 (presence and clients: a client is a node for one person) and ADR-0023 §5
(client capabilities). Uses ADR-0020 §2 and §4 (personal data, the owner reads a member's data only through an audited path), ADR-0029 §3 (per-person
layer in the volatile reminder) and ADR-0014 (zones). Specs: `client.md` ("Client environment"), `parietal.md`, `prefrontal.md` ("Front turn").

## Context

The owner asked the front agent "where am I now" in the terminal. The agent called `client_call` with `location.share`, got `no-client` (the terminal
never announces that capability) and could not answer. Keith also did not know what the person uses: which laptop, which operating system, which
network, what the local time is. A node is known to Keith (its host, OS, state); a person's client was not.

Keith must not guess a place. It must not learn more about a person than the person's own assistant needs: the facts below go only into that person's
own front-agent prompt, never to another person.

## Decision

1. **The client reports its environment; the core keeps it.** On register a client may send `environment`: `host` (the machine name, the `.local` suffix
   dropped, at most 60 characters; an IP address, `localhost` or an empty name is never sent: the terminal asks `scutil` on macOS or reads `/etc/hostname` on
   Linux, and otherwise sends `this computer`), `os` (`macos`, `linux`, `windows`, `other`), `osVersion` (at most 40), `arch` (at most 20), `device` (`laptop`,
   `desktop`, `phone`, `unknown`), `timezone` (an IANA name the platform knows), `locale` (at most 20). The enums are closed and every text has its cap
   and loses its control characters. No IP address, user name or path is ever in it. The terminal detects it (`packages/client/src/environment.ts`)
   with probes: `pmset -g batt` names an internal battery on a laptop, `/sys/class/power_supply/BAT*` does the same on Linux, and any other case is
   `unknown` rather than a guess.
2. **The core derives the network; the client never announces it.** `network` is one of `local-socket`, `loopback`, `lan`, `tailscale`, `public`, taken
   from the listener the register came in on and the TCP peer, through the zone rule of the login (`zoneOf`, `modules/auth/zone.ts`). A request that a
   proxy forwarded is `tailscale` when its peer is a Tailscale address (the Serve proxy, or a tailnet device behind a proxy: the login zone rule,
   Nov 14, 2026 wording fix), and `public` otherwise. The raw address and the Tailscale user name are used
   for the decision and never stored or shown to a model. The node name is not stored.
3. **Storage.** The `clients` table keeps `environment` (JSON, validated again on read; a row that no longer parses reads as unknown) and `network`
   (migration 0024, `ALTER TABLE` only). The record shown to the person carries both; the owner's raw read of another person carries neither (Nov 14, 2026, `RawClientRecordSchema`). Another person's client is never listed to
   anyone (the list is per person, as before).
4. **Always on, no setting.** The front agent of a person always gets the client facts of that person's active client (item 5). There is no per-person
   switch: no table, no RPC, no row in the Me screen. The facts are not a location and never reach another person. Control characters are still
   removed, every text is capped, and no IP address is ever stored or shown. Old `settings.client-context` audit rows (written before the amendment)
   still read in "Privacy" as history.
5. **The reminder.** The front agent's turn reminder gets one block, "Where the person is now", for the person's active client (the presence's active
   client, else the most recently active online one): app, host, OS, device, network and local time in that client's zone. When no online client
   announced `location.share` (the terminal never does), the block also says that no location sensor is online and that the exact place is not known.
   No online client means no block. The block is built in code from the person's own clients and cleaned as data (no control characters, quotes or angle
   brackets), and it is never in the system prompt. It is not a location: a host name says where a machine is named, not where the person sits.
6. **`client_call` describes only what is online.** Its description is built for each turn from the capabilities that an app of the person has online
   now. A capability not listed is unavailable, so `location.share` is not offered when no app announced it.
7. **The terminal's Me screen has no switch.** (Removed by the amendment below; the Me page shows the style and Memory only.)

## Amendment (Nov 12, 2026): the opt-out switch was removed

The owner decided that client context is always on; there is no setting. Reasons: Keith is the owner's personal agent, and the client facts (host, OS,
device, network class, time zone, local time) go only into that person's own front-agent prompt. A switch that hides them from the person's own
assistant only makes Keith worse at answering "where am I". The part that stays: the control-character cleaning and the caps, no IP address anywhere,
and `location.share` stays opt-in and unbuilt.

Removed: `presence.clientContext.get` and `presence.clientContext.set`, the schema `ClientContextSettingSchema`, the table `presence_client_context`
(migration 0025 drops it; an empty table with no data loss, since the switch was on by default), the Me row, and the "share off" branch of the
reminder block. Kept: the audit kind `settings.client-context` as history only (`audit.mine` still summarises it), so the rows of the past remain
readable in "Privacy".

## Amendment (Nov 13, 2026): where the person is, from facts only

The owner keeps "where am I" answerable from what the host, the network and the time zone show: the time zone may name its region. But a place is
never stated as fact. When no online client announced `location.share`, the block now says: answer from what the host, the network and the time zone
show (a time zone may name its region), never name a city, address or building as a fact, and say plainly that the exact place is not known. The
earlier wording ("answer from the host, the network and the time zone") did not forbid a city, which a host name or a time zone can suggest.
The spec (`docs/specs/parietal.md`, "The block") carries the same rule. Test: `context-block.test.ts`.

## Consequences

- Keith can answer "where am I" and "what device is this" from facts it has, and says plainly what it does not know (the exact place). A real location
  waits for a mobile client and `location.share`, as before (ADR-0025 §1).
- The model sees the person's machine facts in every turn of that person's front agent. This is deliberate (amendment): the block is what answers the
  question, and the facts are limited to the person's own clients.
- The network is a coarse class, so a route through a Tailscale Serve proxy is recognised only when the access settings declare that proxy.
- A new migration (0024) adds two nullable columns and one table; existing rows are unchanged. Migration 0025 drops the table again (amendment).
- Revisit when a second client kind (web, mobile) reports a location, or when the owner wants to see members' client facts.
