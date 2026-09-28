# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Azure Code Canvas — production image.
# Zero npm dependencies: the app only uses the Node standard library, so there
# is no install layer and nothing to audit at build time.
# ---------------------------------------------------------------------------
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

# Non-root runtime user (node:22-alpine ships uid/gid 1000 as "node").
COPY --chown=node:node package.json ./
COPY --chown=node:node server.mjs ./
COPY --chown=node:node public ./public

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
