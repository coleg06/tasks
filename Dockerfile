FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build

WORKDIR /app
COPY . .
# Keep build-only dependencies and the npm cache out of Kaniko snapshots.
# The scoped runner enforces a 2 GiB ephemeral-storage limit.
RUN npm ci --ignore-scripts --no-audit --no-fund \
  && npm rebuild --ignore-scripts=false esbuild workerd \
  && npm run build \
  && npm cache clean --force \
  && rm -rf node_modules

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS mcp-runtime

ARG SOURCE_COMMIT
LABEL org.opencontainers.image.title="Tasks MCP runtime" \
      org.opencontainers.image.revision=$SOURCE_COMMIT

ENV NODE_ENV=production \
    TASKS_MCP_HOST=0.0.0.0 \
    TASKS_MCP_PORT=8090

WORKDIR /app
COPY --from=build --chown=node:node /app/dist/mcp ./dist/mcp

USER node
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8090/live"]
CMD ["node", "dist/mcp/standalone.js"]

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS runtime

ENV NODE_ENV=production \
    TASKS_SITE_HOST=0.0.0.0 \
    TASKS_SITE_PORT=8080

WORKDIR /app
COPY --from=build --chown=node:node /app/dist/server.js ./dist/server.js
COPY --from=build --chown=node:node /app/dist/migrate.js ./dist/migrate.js
COPY --from=build --chown=node:node /app/dist/mcp-create-credential.js ./dist/mcp-create-credential.js
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/web/dist ./web/dist

# Writable data location for the optional SQLite/filesystem mode (TASKS_DATASTORE=sqlite). Mount a
# volume here; the rest of the image can run with a read-only root filesystem. Nothing is written
# here, and no datastore is opened, unless TASKS_DATASTORE is set.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
CMD ["node", "dist/server.js"]
