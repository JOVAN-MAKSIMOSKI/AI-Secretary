# syntax=docker/dockerfile:1.7
# Build context = repo root (workspace-aware): docker build -f apps/agent/Dockerfile .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH" CI=true
RUN corepack enable

FROM base AS build
WORKDIR /repo
# Manifests first so the pnpm install layer caches until a dependency changes
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/agent/package.json apps/agent/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter agent...
COPY packages/shared-types packages/shared-types
COPY apps/agent apps/agent
RUN pnpm --filter agent exec prisma generate \
 && pnpm --filter agent build
# pnpm deploy: self-contained hoisted production node_modules (the esbuild
# bundle keeps packages external, so the runtime image must ship real deps).
# prisma generate must re-run inside the deploy dir — the deploy copy does not
# inherit the workspace-generated client. prisma.config.ts is deleted first:
# it is CLI-only tooling that imports the devDependency-only `prisma` package
# (absent from a --prod deploy) and the runtime never reads it; --schema makes
# the config file unnecessary for generate.
RUN pnpm --filter agent deploy --legacy --prod /prod/agent \
 && cd /prod/agent \
 && rm -f prisma.config.ts \
 && npx --yes prisma@7.8 generate --schema prisma/schema.prisma

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /srv/agent
COPY --from=build /prod/agent/node_modules ./node_modules
COPY --from=build /prod/agent/package.json ./package.json
COPY --from=build /repo/apps/agent/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
