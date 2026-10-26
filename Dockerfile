FROM node:24-bookworm-slim AS dependencies

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
    && npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/escrow.sqlite \
    HEALTH_STATUS_PATH=/tmp/dealbot-health.json
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json index.js deploy-commands.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /app/data \
    && chown node:node /app/data \
    && chmod 0700 /app/data
USER node
CMD ["node", "index.js"]
