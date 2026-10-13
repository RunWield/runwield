# Test image. Bun has no equivalent to the former Deno filesystem/subprocess
# permissions. Do not treat this definition as a hardened production deployment.
FROM oven/bun:1.4.3 AS builder
WORKDIR /app

COPY .bun-version bunfig.toml package.json bun.lock runtime-root.js tsconfig*.json ./
COPY scripts ./scripts
COPY src ./src
COPY third_party ./third_party
COPY brand/logo.svg ./brand/logo.svg

RUN bun scripts/check-bun-runtime.ts && bun install --frozen-lockfile --ignore-scripts
RUN bun run workspace:remote:build

FROM oven/bun:1.4.3
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
