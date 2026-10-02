# syntax=docker/dockerfile:1
# Hosted SutramX MCP server: streamable HTTP at POST /mcp. Every request
# carries the caller's own API key (Authorization: Bearer sk_...), so one
# container serves every user. Deployed with backend/docker-compose.prod.yml
# behind Caddy at https://api.sutramx.com/mcp.

# ---------------------------------------------------------------------------
# Build stage — needs devDependencies (typescript).
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ---------------------------------------------------------------------------
# Runtime stage — production dependencies only.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=3333

# tini forwards SIGTERM so in-flight requests are not SIGKILLed. No curl:
# the healthcheck uses node, keeping the runtime image minimal.
RUN apk add --no-cache tini

COPY package.json package-lock.json ./
# --ignore-scripts: no dependency install hooks run in the runtime image.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3333

# /health returns 200 while the process is serving. The Host header must be
# in MCP_ALLOWED_HOSTS, which is why compose lists 127.0.0.1 there.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3333)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
