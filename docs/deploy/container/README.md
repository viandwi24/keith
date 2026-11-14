# Container recipe (untested)

Status: **untested**. Nobody has built this image or run this compose file yet; treat it as a
starting point and report what breaks.

- `Dockerfile` copies the repo, installs production dependencies and runs, as the entrypoint,
  `keith-core setup --non-interactive ... && keith-core start`. The second run of `setup` on the
  same volume only refreshes the values. The first run needs the owner's PIN on stdin (`--owner-pin-stdin`) or
  the entrypoint fails: the owner must be able to sign in.
- Core binds `0.0.0.0` inside the container (`KEITH_HOST`). Publish the port on a private address
  only (compose binds `127.0.0.1`; for Tailscale, publish on the tailnet address). Core has no
  TLS.
- `KEITH_PUBLIC_URL` is the address clients type; its host (and `KEITH_ALLOWED_HOSTS`) are the only
  `Host` names core answers to besides localhost. A wrong value gives HTTP 421.
- The data folder is the `/data` volume. `KEITH_SECRET_KEY` comes from the environment, so the
  volume can be restored without a key file; keep it in your secret store. With a Docker secrets
  file, export it in the entrypoint: `KEITH_SECRET_KEY=$(cat /run/secrets/keith_secret_key)`.
- Provider keys come from the environment (`OPENROUTER_API_KEY`, ...) or `keith-core provider add`.
- Admin from the host: `docker compose exec keith-core bun apps/core/src/cli.ts status`
  (the owner socket is inside the container). Approve a device with
  `... devices approve <code>`; a client logs in with `keith login --core <public url>`.
- Check the result with `... doctor`.
