# Read-only Link CLI MCP connector, as a plain-HTTP Node server.
# Put it behind your own HTTPS reverse proxy. See README "Running it on a VPS".
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8787 \
    LINK_AUTH_FILE=/data/link-auth.json \
    NO_UPDATE_NOTIFIER=1 \
    LINK_CLI_SKIP_SKILL_INSTALL=1

WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: link-cli's postinstall would try to install agent skill files.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src

RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
ENV HOME=/home/node
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1

CMD ["node", "src/server.js"]
