# Net proxy

The core's outbound fetch for public files (`apps/core/src/platform/net-proxy.ts`). Any part of the core that pulls a public resource from
the internet for a person goes through it, so the upstream always sees one well-behaved client: Keith's User-Agent, a bounded number of
requests at once, answers kept for their max-age. It exists because a browser is not a good client for services with a usage policy
(the OpenStreetMap tile servers refused tiles loaded by a sandboxed plugin page in Chrome, while the same tiles loaded fine from the
core). First user: the plugin net route (`thalamus.md`, "Plugin net route"). Related: ADR-0038 (window apps), `plugins/maps.md`.

## Contract

`createNetProxy(options)` → `{ get(url, accept, options?) }`. One instance per core, built in `compose.ts` and passed on the wiring as `w.net`.

| Option | Default | Meaning |
| --- | --- | --- |
| `cacheDir` | `<dataDir>/cache/net` | answers on disk; a backup never carries it (backups carry a fixed list of names) |
| `userAgent` | `keith/<version> (self-hosted personal agent)` | sent on every upstream request; never a person's name, email or instance URL |
| `perHost` | 2 | requests in flight to one host at once (the OSM tile policy's limit) |
| `queue` | 64 | requests waiting for one host; past it a new request is `503` (or a stale copy) |
| `maxBytes` | 4 MiB | largest answer relayed or kept (`413`) |
| `defaultTtlMs` | 7 days | fresh life of an answer without `max-age` |
| `timeoutMs` | 15 s | upstream timeout (`504`) |
| `maxCacheBytes` | 256 MiB | every 200 writes, oldest files are removed until the cache fits |

`get(url, accept)`:

- `url` must be `https:` without user info (`400`). Only `GET`; `redirect: 'error'` (an answer comes from the host that was asked, never a
  redirect target); `credentials: 'omit'`; headers are the User-Agent and `Accept` only.
- A fresh cached copy is returned without a request (`from: 'cache'`). Fresh life: `max-age` clamped to [1 h, 30 d]; `no-store` is never kept.
- `options.liveMs` (the plugin net route's live hosts, 20 s): the fresh life is at most `liveMs` (at least 1 s), whatever the `max-age`.
- `options.sniff(body)`: an untyped answer (`application/octet-stream` or no `Content-Type`) is read and kept only when `sniff` names
  one of `accept` from its bytes, under that type.
- The answer's media type must be one of `accept` (`415`); upstream `404`/`410` is `404`; any other non-2xx, a network error, a timeout or a
  full queue returns the stale cached copy when there is one (`from: 'stale'`), else `502`/`504`/`503` with a one-line reason.
- Cache files: `<cacheDir>/<first two hex>/<sha256(url)>` and `<…>.json` (`{ url, type, expires }`), each written to a temp name and renamed.

## Not here (yet)

- Plugins do not get it on `ctx` yet: their server code still uses its own `fetch` (the maps operations, through their own throttle: JSON answers about the person's places are not cached on disk). Offering `k.net` is a later step.
- No per-person accounting: the cache is shared by everyone on the instance, which is the point (one fetch per tile).

## Tests

`apps/core/src/platform/net-proxy.test.ts`: User-Agent, no redirect, max-age caching and expiry, stale on failure, https only, accepted type,
size cap, 404, the per-host limit and the queue, `freshFor`.
