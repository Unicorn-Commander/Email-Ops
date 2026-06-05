# syntax=docker/dockerfile:1
# Email-Ops backend — NestJS + Prisma.
# Prisma migrations are applied on container start (docker-entrypoint.sh), then
# the API boots. Runtime keeps full node_modules so the prisma CLI is available
# for `migrate deploy` without a network fetch.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:20-bookworm-slim AS build
WORKDIR /app
# openssl/libssl present so `prisma generate` detects the right engine target
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:20-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production
# openssl: prisma query engine; curl: container healthcheck
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 3231
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=6 \
  CMD curl -fsS http://localhost:3231/api/v1/health || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
