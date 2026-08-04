FROM --platform=linux/amd64 node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-freefont-ttf \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# ── Backend dependencies ───────────────────────────────────────────────────
COPY package*.json ./
RUN npm ci --omit=dev

# ── Frontend build ─────────────────────────────────────────────────────────
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci
COPY frontend/ ./frontend/
RUN cd frontend && npm run build && rm -rf node_modules

# ── Copy rest of app source ────────────────────────────────────────────────
COPY . .

EXPOSE 4000

CMD ["node", "server.js"]
