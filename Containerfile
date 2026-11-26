# Test image. Bun has no equivalent to the former Deno filesystem/subprocess
# permissions. Do not treat this definition as a hardened production deployment.
# Supply the checked-out pin via scripts/plan-server-container.sh or --build-arg.
ARG BUN_VERSION
FROM docker.io/oven/bun:${BUN_VERSION} AS bun-base

FROM bun-base AS builder
ARG BUN_VERSION
WORKDIR /app

COPY .bun-version bunfig.toml package.json bun.lock runtime-root.ts tsconfig*.json ./
COPY packages/agents ./packages/agents
COPY packages/bundled-assets ./packages/bundled-assets
COPY packages/parsing ./packages/parsing
COPY packages/pi-ai ./packages/pi-ai
COPY packages/plans ./packages/plans
COPY packages/projects ./packages/projects
COPY packages/resources ./packages/resources
COPY packages/session-files ./packages/session-files
COPY packages/session-runtime ./packages/session-runtime
COPY packages/tools ./packages/tools
COPY packages/workflow ./packages/workflow
COPY scripts ./scripts
COPY src ./src
COPY third_party ./third_party
COPY packaging/remote ./packaging/remote
COPY brand/logo.svg ./brand/logo.svg

RUN expected=$(sh scripts/read-bun-version.sh) && actual=$(bun --version) \
    && if [ "$BUN_VERSION" != "$expected" ] || [ "$actual" != "$expected" ]; then \
        printf 'Expected Bun %s from .bun-version; build requested %s and runs %s.\n' \
            "$expected" "$BUN_VERSION" "$actual" >&2; exit 1; \
    fi \
    && bun scripts/check-bun-runtime.ts && bun install --frozen-lockfile --ignore-scripts
RUN bun run workspace:remote:build

FROM bun-base
WORKDIR /app

ENV HOME=/data \
    RUNWIELD_REMOTE_HOST=0.0.0.0 \
    RUNWIELD_REMOTE_PORT=8080 \
    RUNWIELD_REMOTE_DB_PATH=/data/runwield-shared-spaces.sqlite \
    RUNWIELD_REMOTE_MAX_REQUEST_BYTES=5242880

# Keep the previous image's numeric volume owner; application assets stay root-owned.
RUN groupadd --gid 1993 runwield && useradd --uid 1993 --gid 1993 --no-create-home runwield \
    && mkdir -p /data && chown 1993:1993 /data
COPY --from=builder /app/dist/plan-server/ ./
USER 1993:1993
EXPOSE 8080
VOLUME ["/data"]

ENTRYPOINT ["bun"]
CMD ["--no-env-file", "--no-install", "remote-server.js"]
