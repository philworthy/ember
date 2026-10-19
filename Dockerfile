# syntax=docker/dockerfile:1
# Ember: the server, the built PWA, and the food catalog seed, in one image for the NAS.
# Built and published by .github/workflows/image.yml; docs/deploy.md covers running it.

# The client is plain files, so build it once on the build machine's own CPU.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS client
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY client/ client/
RUN npm run build

# The runtime installs for the target CPU: tsx's esbuild binary is per-platform.
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace @ember/server && npm cache clean --force
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
COPY docs/food-catalog.json docs/
COPY --from=client /app/client/dist client/dist

ENV DATA_DIR=/data \
    USE_SIMULATOR=false \
    EMBER_PORT=8080
VOLUME /data
EXPOSE 8080
WORKDIR /app/server
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# node is PID 1 so SIGTERM reaches the server's shutdown handler directly.
CMD ["node", "--import", "tsx", "src/index.ts"]
