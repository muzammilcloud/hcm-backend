# ────────────────────────────────────────────────────────────────────────────
# Stage 1 — Install production dependencies only
# ────────────────────────────────────────────────────────────────────────────
FROM node:18-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force


# ────────────────────────────────────────────────────────────────────────────
# Stage 2 — Runtime
# ────────────────────────────────────────────────────────────────────────────
FROM node:18-alpine AS runtime

WORKDIR /app

# wget is used by HEALTHCHECK; tini reaps zombies and forwards signals cleanly.
# chromium + font-noto-cjk + nss + freetype + harfbuzz + ca-certificates power
# Puppeteer-rendered salary slip PDFs with full CJK glyph coverage (Noto Sans
# JP / SC / KR all live in font-noto-cjk). PUPPETEER_EXECUTABLE_PATH below
# points puppeteer-core at the system Chromium so we don't bundle our own.
RUN apk add --no-cache \
      wget tini \
      chromium nss freetype harfbuzz ca-certificates \
      font-noto-cjk ttf-dejavu

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Copy node_modules and source as the non-root `node` user that ships in
# the alpine base image. Running as non-root is a basic hardening step.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

USER node

ENV NODE_ENV=production
ENV PORT=4001
# Cap V8 heap so the process stays within container memory limits on small hosts.
ENV NODE_OPTIONS=--max-old-space-size=256

EXPOSE 4001

# start-period is generous: the app runs per-tenant migrations + backfills
# before it starts listening, so /health is unavailable until those finish.
# Health-check failures during start-period don't count against the container.
HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=240s \
  CMD wget --spider -q http://localhost:4001/health || exit 1

# tini as PID 1 — ensures SIGTERM during deploys actually terminates Node.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
