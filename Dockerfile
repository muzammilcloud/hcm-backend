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
RUN apk add --no-cache wget tini

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

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
  CMD wget --spider -q http://localhost:4001/health || exit 1

# tini as PID 1 — ensures SIGTERM during deploys actually terminates Node.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
