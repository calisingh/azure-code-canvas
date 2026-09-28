# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# renderd — runs inside an Azure Container Apps dynamic session (micro-VM).
# One session serves exactly one generated artifact over HTTP.
# ---------------------------------------------------------------------------
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app
COPY --chown=node:node server.mjs ./

USER node
EXPOSE 8080

CMD ["node", "server.mjs"]
