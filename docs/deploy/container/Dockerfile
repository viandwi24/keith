# Keith core in a container. UNTESTED recipe: see README.md in this folder.
# Build from the repo root:  docker build -f docs/deploy/container/Dockerfile -t keith-core .
FROM oven/bun:1.4.2
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --production
ENV KEITH_DATA_DIR=/data \
    KEITH_HOST=0.0.0.0 \
    KEITH_PORT=7420
VOLUME /data
EXPOSE 7420
# Setup is a no-op on an already configured volume, so the entrypoint runs it every time.
ENTRYPOINT ["/bin/sh", "-c", "bun apps/core/src/cli.ts setup --non-interactive --owner-name \"${KEITH_OWNER_NAME:-Owner}\" --provider \"${KEITH_PROVIDER:-skip}\" --access remote --public-url \"${KEITH_PUBLIC_URL}\" && exec bun apps/core/src/cli.ts start --no-setup-check"]
