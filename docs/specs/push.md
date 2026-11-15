# Web Push

Code: `apps/core/src/modules/push/` (`encrypt.ts`, `vapid.ts`, `sender.ts`, `keys.ts`, `service.ts`, `procedures.ts`, `removal.ts`),
`apps/core/src/compose-push.ts`, `packages/contracts/src/push.ts`, `packages/db/src/repos/push-subscriptions.ts`,
`packages/client/src/push.ts`. Decisions: ADR-0035 (the web client), ADR-0034 §6 (the reach ladder and its `push` slot).

## Purpose

A person who is away from the desk is reached by a push notification on a browser that subscribed. Push is a **companion** route of the
reach ladder: it announces that Keith has something, and the front session still gets the message (the chat is the place to read it).
There is no `web-push` dependency (ADR-0006): the sender is WebCrypto and `fetch`.

## Contracts

`packages/contracts/src/push.ts` (exported from `area-runtime.ts`), the oRPC branch `presence.push` (every call `can('authenticated')`, always the
caller's own rows; no argument names another person):

| Call | Input | Output |
| --- | --- | --- |
| `presence.push.publicKey` | none | `{ publicKey }`: the VAPID public key, 65 bytes as base64url (the `applicationServerKey`) |
| `presence.push.subscribe` | `{ subscription, clientId?, label?, userAgent? }` | `PushRecord` |
| `presence.push.unsubscribe` | `{ id }` or `{ endpoint }` | `{ ok: true }` (idempotent; another person's id or endpoint does nothing) |
| `presence.push.list` | none | `PushRecord[]` (the caller's, oldest first) |
| `presence.push.preview.get` / `.set` | none / `{ preview }` | `{ preview }`: the setting `push.preview`, default `false` |

- `PushSubscriptionSchema` is the browser's `PushSubscription.toJSON()`: `endpoint` (https URL, at most 2048 characters, no credentials), `keys.p256dh`
  (65 bytes, base64url, 86 to 88 characters), `keys.auth` (16 bytes, base64url, 22 to 24), `expirationTime` (optional).
- `PushRecord`: `id`, `clientId`, `label` (at most 60), `userAgent` (at most 300), `createdAt`, `lastSuccessAt`, `failures`. **Never the endpoint or the keys.**
- Refusals: `BAD_REQUEST` for an endpoint the core may not call (not https, an IP literal, `localhost`, a name without a dot or ending `.local`, `.localhost`,
  `.internal`, `.lan`, `.home.arpa`; this keeps a signed-in person from aiming the core at its own network); `CONFLICT` for the 11th subscription of a person
  (`PUSH_SUBSCRIPTIONS_PER_PERSON_MAX`).
- Subscribing an endpoint that is already stored updates that row (keys, labels, failure count reset, id and creation time kept). If the stored row is
  another person's, it moves to the caller: the endpoint belongs to the browser, and the person signed in on it is the one who gets its pushes.
- `PushPayloadSchema` `{ title, body, url, tag }`: the JSON the service worker receives.

## Data

Table `push_subscriptions` (migration 0027, `schema/presence.ts`, see `db.md`): `id`, `person_id`, `endpoint` (unique), `p256dh`, `auth`, `client_id`, `label`,
`user_agent`, `created_at`, `last_success_at`, `failure_count`. The `push.preview` setting of a person is the `settings` key `push.preview.<personId>`
(absent means off). The removal registry deletes both with the person (`pushRemoval`: nothing is kept or exported: a subscription is a device secret).

## VAPID

- One ECDSA P-256 key pair per core, generated with WebCrypto the first time the core starts (`loadVapidKeys`). The public key is stored in the
  `settings` key `push.vapid` next to the private key as a JWK **sealed by the vault** (`vault.seal(jwk, 'push.vapid')`, AES-256-GCM, ADR-0007); the
  private key never leaves the process unsealed and is imported non-extractable.
- A stored pair the vault cannot open (the secret key changed) is replaced with a warning. Subscriptions made with the old public key then get 401 or 403 from
  their push service, count up as failures and are dropped; the browsers subscribe again.
- Subject: `KEITH_PUSH_SUBJECT` (a `mailto:` or https URL, read in `platform/config.ts`), else `KEITH_PUBLIC_URL` when it is https, else the placeholder
  `mailto:keith@localhost.invalid` (a public push service may refuse that: set the variable on a core that serves phones).
- The JWT of a request (RFC 8292): header `{ typ: 'JWT', alg: 'ES256' }`, claims `aud` (the **origin** of the endpoint), `exp` (now + 11 hours; the limit is 12),
  `sub` (the subject), signed ES256 (WebCrypto's r||s form is the JWS form). `Authorization: vapid t=<jwt>, k=<public key base64url>`.

## Encryption

RFC 8291 with the content coding `aes128gcm` (RFC 8188), WebCrypto only, one record (`encryptPayload`):

1. A fresh ephemeral ECDH P-256 key pair and a random 16-byte salt per message.
2. `ecdh = ECDH(server private, p256dh)`; `IKM = HKDF(salt: auth, ikm: ecdh, info: "WebPush: info\0" || p256dh || server public, 32)`.
3. `CEK = HKDF(salt, IKM, "Content-Encoding: aes128gcm\0", 16)`, `NONCE = HKDF(salt, IKM, "Content-Encoding: nonce\0", 12)`.
4. AES-128-GCM over `payload || 0x02` (the last-record delimiter). The body is `salt (16) || record size (4096, 4 bytes) || key id length (65) || server public (65) || record`.

A payload is at most 4079 bytes (record size less the tag and the delimiter); the neutral payload is far below. `encrypt.test.ts` pins the RFC 8291 Appendix A
test vector byte for byte.

## Sending

`createPushSender` POSTs to the endpoint with `Authorization` (above), `Content-Encoding: aes128gcm`, `Content-Type: application/octet-stream`, `TTL: 3600` (a
message is stale after an hour), `Urgency: high` for a delivery with `needs.urgency: 'high'` and `normal` otherwise. A 10 s timeout, redirects are not
followed, the response body is never read. A result is `ok` (any 2xx), `gone` (404 or 410: the push service says the subscription is dead) or a plain failure
(any other status, a network error, malformed stored keys). The sender never throws.

### Failure handling

- `gone`: the subscription row is deleted.
- Another failure: `failure_count` goes up; the row is deleted at `MAX_FAILURES` (5) failures in a row. A success sets `last_success_at` and resets the count.
- Subscriptions are sent to in parallel; the route reports `ok` when at least one push was accepted. A route with no subscription is `unavailable` (the planner does
  not ask for one: see below).

## Payload and privacy

`{ title: 'Keith', body, url, tag }`:

- `body` is **neutral** (`Keith has something for you`) unless the person turned `push.preview` on; then it is the delivery text on one line, clipped to 140
  characters. The push service sees only ciphertext either way; the setting decides whether the lock screen shows text.
- `url` deep-links into the web app: `/app`, or `/app/inbox` for a delivery named `approval` (or with a source starting `approval`).
- `tag` is the delivery id (at most 100 characters): the browser replaces a notification of the same tag, so a retry never stacks.
- The audit row of a push (`delivery.push`: `id`, `source`, `to`, `subscription` id, `ok`, `status`) holds **no endpoint, no key and no text**. The member's
  audit view hides it; `push.subscribed`, `push.unsubscribed` and `push.preview.set` (detail: `subject`, and `preview`) read as lines about the person's own settings.

## The route in the reach ladder

`createPushService(...).route(personId)` is a `DeliveryRoute` with id `push` and `companion: true` (`delivery.md`, "Service"). The planner asks for it only when
`pushWanted` says so (`parietal.md`, "Routing"), and only when the person has a subscription (`compose-delivery.ts`). It sends once per delivery id: a retry of the
front route does not push again (a bounded memory of the last 500 delivery ids; the `tag` also folds a repeat on the device).

## Client

`packages/client/src/push.ts`, browser-safe (also exported from `@keith/client/browser`): `pushPublicKey(client)`, `applicationServerKeyOf(publicKey)` (the bytes
`pushManager.subscribe` wants), `subscribePush(client, subscription, label, { clientId?, userAgent? })` (a `PushSubscription` or its JSON; the label is clipped to 60),
`unsubscribePush(client, { id } | { endpoint })`, `listPush(client)`. The service worker and `pushManager` belong to `apps/web` (below).

## Web client

`apps/web` (`docs/specs/web.md`, "PWA" and "Push"): `src/service-worker/index.ts` handles `push` and `notificationclick`; `features/push` is the subscription UI. The page registers the worker (scope `/app/`), asks for permission only from a click, subscribes with
`applicationServerKeyOf(await pushPublicKey(client))` and `userVisibleOnly: true`, and calls `subscribePush` with the label `<browser> (web)`, its presence client id and the user agent; turning it off calls `unsubscribePush({ endpoint })` and unsubscribes the browser. The panel lists `listPush` (this device first, by
`clientId`), removes a device by id and holds the `push.preview` switch (off by default, with the lock-screen privacy note).

- **Payload to notification.** `planOf` (`features/pwa/sw-logic.ts`): `title` (80 characters, default `Keith`), `body` (one line, 200 characters, neutral `Keith has something for you` when empty or unreadable), `tag` (100) and `data.url`, kept only inside `/app/` (another origin or path becomes the app root). A push with no data shows the neutral notification.
- **Click.** The notification closes; an open window of the app is navigated to the url and focused, else a new window opens.
- **Conditions shown to the person.** HTTPS or localhost (a secure context), and on iOS 16.4 or later a Home Screen install; `availabilityOf` names the missing one.

## Audit

| Kind | Detail | Subject |
| --- | --- | --- |
| `delivery.push` | `id`, `source`, `to`, `subscription`, `ok`, `status` | `to` |
| `push.subscribed` | `subject`, `subscription` | `subject` |
| `push.unsubscribed` | `subject` | `subject` |
| `push.preview.set` | `subject`, `preview` | `subject` |

## Tests

`encrypt.test.ts` (the RFC 8291 vector, header layout, fresh salt and key, size limit, bad keys), `sender.test.ts` (JWT shape and signature, headers, 404/410/other
statuses, network errors), `keys.test.ts` (sealed private key, replacement of an unreadable pair, subject), `service.test.ts` (subscriptions, limits, own rows, payload
privacy, failure counting and dropping, audit without endpoint), `procedures.test.ts` (a real core: own rows only, refusals, preview), `parietal/planner-push.test.ts` (the
ladder rows with push), `delivery/delivery.test.ts` ("companion routes"), `packages/db` (`repos/push-subscriptions.test.ts`, `migration-0027.test.ts`),
`packages/client/src/push.test.ts`.
