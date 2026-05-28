FROM node:22-alpine AS build

WORKDIR /app
COPY package*.json ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/server/package.json    ./packages/server/
COPY packages/sdk/package.json       ./packages/sdk/
COPY packages/cli/package.json       ./packages/cli/

RUN npm ci --silent

COPY tsconfig.base.json ./
COPY packages/ ./packages/
RUN npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY packages/server/package.json ./packages/server/

# Install only server production deps
RUN npm ci --workspace @agentroom/server --omit=dev --silent

COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/server/dist   ./packages/server/dist

VOLUME /data
ENV AGENTROOM_DB=/data/agentroom.db
ENV PORT=8787

# su-exec allows entrypoint to drop from root → node after fixing /data ownership
RUN apk add --no-cache su-exec

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:8787/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "packages/server/dist/index.js"]
