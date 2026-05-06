# =========================
# Stage 1: Dependencies
# =========================
FROM node:18 AS deps

WORKDIR /app

COPY package*.json ./

# install only production deps
RUN npm install


# =========================
# Stage 2: Runtime
# =========================
FROM node:18-slim AS runtime

WORKDIR /app

# Install only runtime OS deps (wget for healthcheck)
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/*

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY . .

ENV NODE_ENV=production
ENV PORT=4001

EXPOSE 4001

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
CMD wget --spider http://localhost:4001/health || exit 1

CMD ["node", "server.js"]
