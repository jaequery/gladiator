# syntax=docker/dockerfile:1
#
# The Fly.io image for `packages/server`.
#
# The shape that matters is that the runtime stage contains **one JavaScript
# file and a plain `node_modules`** — no pnpm, no workspace, no symlinks. pnpm's
# store is a graph of symlinks into `.pnpm`, and copying that graph between
# stages is where "works locally, `ERR_MODULE_NOT_FOUND` in production" comes
# from. esbuild bundles `@gladiator/sim` and `@gladiator/bot` straight into the
# output, so there is nothing left to resolve.
#
# `ws` is the one exception: it stays external because it is a real dependency
# with optional native accelerators, and bundling it means bundling its
# `require` of packages that may not be installed. It is installed on its own,
# with npm, at the version `packages/server/package.json` pins — read from that
# file rather than repeated here, so the two cannot drift.

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
FROM node:22-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Manifests first, so a change to source code does not invalidate the install
# layer. The four package manifests have to be copied individually: pnpm reads
# every workspace member before it will install anything.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sim/package.json packages/sim/
COPY packages/bot/package.json packages/bot/
COPY packages/client/package.json packages/client/
COPY packages/server/package.json packages/server/

# `--filter @gladiator/server...` installs the server and what it depends on,
# and skips Babylon — a hundred megabytes this image has no use for.
RUN pnpm install --frozen-lockfile --filter @gladiator/server...

COPY tsconfig.base.json ./
COPY packages/sim packages/sim
COPY packages/bot packages/bot
COPY packages/server packages/server

# The baked maps. `packages/server/src/map.ts` imports `maps/baked/*.json`
# directly and esbuild inlines it, so the image carries the arena in the same
# file as the code and cannot start holding a different one. Without this the
# build fails to resolve rather than starting up mapless, which is the right way
# round.
COPY maps/baked maps/baked

RUN pnpm --filter @gladiator/server run build

# The runtime dependency tree, built with npm so it is real directories rather
# than a pnpm symlink graph. The version comes from the manifest, so a bump to
# `ws` cannot leave the runtime behind.
RUN WS_VERSION="$(node -p "require('/app/packages/server/package.json').dependencies.ws")" \
  && mkdir -p /runtime \
  && cd /runtime \
  && npm install --omit=dev --no-audit --no-fund --no-save "ws@${WS_VERSION}" \
  && printf '{"private":true,"type":"module"}\n' > /runtime/package.json

# `"type": "module"` is load-bearing: esbuild emits ESM, and without a manifest
# saying so Node parses a bare `.js` as CommonJS and dies on the first `import`.

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production
# Fly overrides this via fly.toml; the default keeps `docker run` working.
ENV PORT=8080

# The commit this image was built from. Passed by `flyctl deploy --build-arg`,
# and shown to a client whose protocol version does not match — "server is on
# build X, reload" is only useful if X means something.
ARG GLADIATOR_BUILD=dev
ENV GLADIATOR_BUILD=$GLADIATOR_BUILD

WORKDIR /app

COPY --from=build /runtime/package.json ./package.json
COPY --from=build /runtime/node_modules ./node_modules
COPY --from=build /app/packages/server/dist/index.js ./index.js

USER node
EXPOSE 8080

# node is PID 1 and installs its own SIGTERM handler in `index.ts`, which is
# what `kill_timeout` in fly.toml gives time to run.
CMD ["node", "index.js"]
