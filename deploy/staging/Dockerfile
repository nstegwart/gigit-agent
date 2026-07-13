# Staging-only image for cairn-taskmanager-v3 (TM-P0).
# Built from repo root: docker build -f deploy/staging/Dockerfile --build-arg CAIRN_DEPLOYED_SHA=<full-sha> .
# App listens on 3210 inside the container; host bind is 127.0.0.1:33211 via compose.

# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24.8.0
ARG PNPM_VERSION=11.5.2

FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
# App source + assets required for vite / tanstack start production build.
COPY tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
COPY migrations ./migrations
# Committed seed index only (demo board is not staging SSOT; staging uses synthetic MySQL fixtures).
COPY data/boards.json data/conventions.json ./data/
COPY data/boards/demo ./data/boards/demo
ARG CAIRN_DEPLOYED_SHA=unknown
ENV CAIRN_DEPLOYED_SHA=${CAIRN_DEPLOYED_SHA}
ENV NODE_ENV=production
RUN pnpm build

FROM base AS runtime
ARG CAIRN_DEPLOYED_SHA=unknown
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3210
ENV CAIRN_DEPLOYED_SHA=${CAIRN_DEPLOYED_SHA}
ENV CAIRN_EXPECTED_SHA=${CAIRN_DEPLOYED_SHA}
# Staging class markers (compose also injects; baked defaults keep image self-describing).
ENV CAIRN_ENV=staging
ENV CAIRN_DB_NAME=cairn_tm_v3_staging
ENV CAIRN_STAGING_DB_HOSTS=cairn-tm-v3-mysql
LABEL org.opencontainers.image.title="cairn-tm-v3-app"
LABEL org.opencontainers.image.description="Cairn task-manager staging app (isolated synthetic stack)"
LABEL cairn.stack="cairn-tm-v3"
LABEL cairn.env="staging"
LABEL cairn.deployed_sha="${CAIRN_DEPLOYED_SHA}"

WORKDIR /app
COPY --from=build /app /app

# Synthetic staging seeder sources only (no dirty data/** board dumps).
# Required for: node deploy/staging/scripts/seed-synthetic.mjs
COPY qa/e2e/fixtures/seed ./qa/e2e/fixtures/seed
COPY qa/e2e/lib/db-iso.mjs ./qa/e2e/lib/db-iso.mjs
COPY qa/e2e/lib/probe-fail-close.mjs ./qa/e2e/lib/probe-fail-close.mjs
COPY qa/fixtures/staging ./qa/fixtures/staging
COPY deploy/staging/scripts ./deploy/staging/scripts

EXPOSE 3210

# Unauthenticated /api/healthz returns 401 when the SSR server is up (auth required).
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=8 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3210)+'/api/healthz').then(r=>process.exit(r.status===401||r.status===200||r.status===503?0:1)).catch(()=>process.exit(1))"

# Serve the production build (SSR + server fns + MCP) on container port 3210.
CMD ["pnpm", "preview", "--host", "0.0.0.0", "--port", "3210", "--strictPort"]
