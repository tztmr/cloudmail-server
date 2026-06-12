FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY mail-worker/package.json mail-worker/pnpm-lock.yaml mail-worker/pnpm-workspace.yaml ./mail-worker/
COPY mail-vue/package.json mail-vue/pnpm-lock.yaml mail-vue/pnpm-workspace.yaml ./mail-vue/

RUN npm install -g pnpm@9
RUN cd mail-worker && pnpm install --frozen-lockfile
RUN cd mail-vue && pnpm install --frozen-lockfile

COPY . .

RUN cd mail-vue && pnpm run build -- --mode release
RUN cd mail-worker && pnpm run build:server

FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/mail-worker

COPY --from=builder /app/mail-worker/package.json ./package.json
COPY --from=builder /app/mail-worker/node_modules ./node_modules
COPY --from=builder /app/mail-worker/dist ./dist
COPY --from=builder /app/mail-worker/dist-server ./dist-server

RUN mkdir -p /app/data

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/app/data \
    STATIC_DIR=/app/mail-worker/dist \
    SMTP_ENABLED=true \
    SMTP_PORT=2525

EXPOSE 3000 2525

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/setting/websiteConfig', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist-server/server.cjs"]
