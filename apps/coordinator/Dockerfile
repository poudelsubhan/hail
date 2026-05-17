# Single-stage build. The coordinator runs TS via tsx at runtime — there's
# no separate compile step, so we don't need a slimmer runtime image. Keeps
# the Dockerfile easy to reason about and rebuilds fast.
FROM node:22-slim AS base

# better-sqlite3 builds from source via node-gyp on install. Need python3 +
# g++ to satisfy the build. Removed after install to keep the image small.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Use corepack to pin pnpm to whatever the repo's packageManager field says.
RUN corepack enable

WORKDIR /app

# Copy only the files needed to resolve the dep graph first — this lets
# Docker cache the `pnpm install` step across code-only edits.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/llm/package.json ./packages/llm/
COPY packages/x402/package.json ./packages/x402/
COPY apps/coordinator/package.json ./apps/coordinator/

# Install just the coordinator's transitive dep set. `--frozen-lockfile`
# is mandatory in CI — fail fast if the lockfile drifted.
RUN pnpm install --filter @ac/coordinator... --frozen-lockfile

# Now the source. Coordinator + the three @ac/* packages it imports.
COPY packages/contracts ./packages/contracts
COPY packages/llm ./packages/llm
COPY packages/x402 ./packages/x402
COPY apps/coordinator ./apps/coordinator

# Reduce log noise from Anthropic SDK in serverless contexts.
ENV NODE_ENV=production

# Fly's [mounts] in fly.toml puts a persistent volume at /data. SQLITE_PATH
# in fly.toml [env] tells the coord to write the DB there.
EXPOSE 8787

WORKDIR /app/apps/coordinator
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
