# syntax=docker/dockerfile:1
# Email-Ops frontend — Next.js (next.config: output: 'standalone').
# Serves the cockpit and proxies /api/v1/* to the backend server-side
# (next.config rewrite -> BACKEND_ORIGIN), so only the frontend is exposed.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
# Next standalone server bundles a minimal node_modules + server.js. standalone
# does NOT include public/ or .next/static — copy both. public/ carries the
# Brigade federation manifest (.well-known/mcps.json) served at the root URL.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=6 \
  CMD curl -fsS http://localhost:3000/ || exit 1
CMD ["node", "server.js"]
