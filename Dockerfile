# check=skip=SecretsUsedInArgOrEnv
FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS install
COPY package.json bun.lock ./
# COPY patches ./patches
RUN bun install --frozen-lockfile

# Build application (use Node for Vite build — Bun lacks dns.promises.getDefaultResultOrder)
FROM node:22-slim AS build
WORKDIR /app
COPY --from=install /app/node_modules ./node_modules
COPY . .

# Build-time env vars for Vite static replacement
ARG VITE_CONVEX_URL
ARG VITE_CONVEX_SITE_URL

ENV VITE_CONVEX_URL=$VITE_CONVEX_URL
ENV VITE_CONVEX_SITE_URL=$VITE_CONVEX_SITE_URL

RUN npx vite build

# Production image
FROM base AS release
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

EXPOSE 3000

# Run the application
CMD ["bun", "run", "start"]
