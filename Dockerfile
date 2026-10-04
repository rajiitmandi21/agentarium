FROM node:22-bookworm-slim AS runtime-deps

WORKDIR /app

# better-sqlite3 is a native LangGraph checkpointer dependency. Build it against
# the same Node/Debian runtime used below; the toolchain stays out of final image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4747 \
    MAESTRO_CHECKPOINT_PATH=/var/lib/agentarium/maestro/checkpoints.sqlite

COPY --from=runtime-deps --chown=node:node /app/node_modules ./node_modules
COPY package.json package-lock.json server.js coordination-transactions.js ./
COPY index.html Atlas.html khira.html ./
COPY styles.css data.js sanitize.js helpers.js edits.js projects.js provenance.js pm-loader.js ./
COPY tweaks-panel.jsx components.jsx views.jsx drawer.jsx project-switcher.jsx app.jsx ./
COPY agentarium ./agentarium
COPY scripts/crews-dispatch-resolver.js ./scripts/crews-dispatch-resolver.js

RUN mkdir -p /app/project-management /var/lib/agentarium/maestro \
    && chown -R node:node /app /var/lib/agentarium

USER node

EXPOSE 4747

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["node", "-e", "const http=require('http');const r=http.get('http://127.0.0.1:4747/api/health',s=>{s.resume();process.exit(s.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.setTimeout(2000,()=>{r.destroy();process.exit(1)})"]

CMD ["node", "server.js"]
