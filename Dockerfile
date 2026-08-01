# syntax=docker/dockerfile:1

# Multi-stage: build stage compiles both workspace packages (server's tsc
# build + web's vite build) with full devDependencies and native-module
# build tools available; the runtime stage only needs ffmpeg (for HLS
# transcoding, spawned as a child process — see server/src/playback/
# hlsSession.ts) plus whatever pnpm actually installed. Both stages share
# the same base image so pnpm's relative symlink structure (per-workspace
# node_modules symlinking into the shared .pnpm store) stays valid when
# copied across stages wholesale.
FROM node:24-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile && pnpm run build

FROM node:24-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/server
# node:alpine's built-in unprivileged user (uid 1000) — matches this
# homelab's own skip/uid-1000 convention, so a bind-mounted host data/
# directory owned by skip is writable without any extra chown step.
USER node
EXPOSE 4300
# Migrations are idempotent (drizzle only applies unapplied ones) — safe to
# run on every container start rather than requiring a separate manual step.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
