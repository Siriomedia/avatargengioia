# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-slim AS deps

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-slim

# FFmpeg (necessario per assemble-reel)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dipendenze da stage precedente
COPY --from=deps /app/node_modules ./node_modules

# Codice sorgente (senza .env, node_modules, output)
COPY . .

# Directory dati persistenti (montata come volume Railway su /data)
RUN mkdir -p /data/output /data/photos /data/logs /data/config

# Porta esposta
EXPOSE 3333

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3333/api/status', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
