# CloudMail one-click Docker image
# Build: docker build -t cloudmail .
# Run:   docker run -p 3000:3000 -p 2525:2525 -v cloudmail-data:/app/data -e JWT_SECRET=xxx ... cloudmail

FROM node:20-slim AS builder

# Install build tools for better-sqlite3 native module
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better layer caching
COPY mail-worker/package.json mail-worker/pnpm-lock.yaml ./mail-worker/
COPY mail-vue/package.json mail-vue/pnpm-lock.yaml ./mail-vue/

# Install pnpm globally
RUN npm install -g pnpm@9

# Install deps (builder needs full for build + native compile)
RUN cd mail-worker && pnpm install --frozen-lockfile
RUN cd mail-vue && pnpm install --frozen-lockfile --ignore-scripts

# Copy full source
COPY . .

# Build frontend into mail-worker/dist
RUN cd mail-vue && pnpm run build -- --mode release

# Also make sure mail-worker has the dist (build script already puts it in ../mail-worker/dist in some cases)
# The vite outDir in config may put it in mail-worker/dist when run from vue, but we ensure copy
RUN mkdir -p mail-worker/dist && cp -r mail-vue/dist/* mail-worker/dist/ 2>/dev/null || true

# --- Runtime stage ---
FROM node:20-slim

# Runtime minimal deps (better-sqlite3 prebuilt or will use the one from builder? We copy node_modules)
# To keep simple and reliable we copy the whole built app (including compiled native)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built artifacts + node_modules from builder (contains the compiled better-sqlite3)
COPY --from=builder /app/mail-worker /app/mail-worker
COPY --from=builder /app/mail-vue/dist /app/mail-worker/dist 2>/dev/null || true

# Create data dir (will be volume mounted)
RUN mkdir -p /app/mail-worker/data

WORKDIR /app/mail-worker

# Default env (override in compose or run)
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    STATIC_DIR=/app/mail-worker/dist \
    SMTP_ENABLED=true \
    SMTP_PORT=2525

# Expose web + smtp
EXPOSE 3000 2525

# Healthcheck (simple)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/setting/websiteConfig', r => process.exit(r.statusCode===200||r.statusCode===501?0:1)).on('error',()=>process.exit(1))" || exit 1

# Run the server (pnpm not needed in runtime, use node directly)
CMD ["node", "src/server.js"]
