# syntax=docker/dockerfile:1.7
# ------------------------------------------------------------------
# Tabula Keeper — TxLINE ⇆ TabFM ⇆ Solana bridge.
# ------------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

COPY keeper/package.json keeper/tsconfig.json /app/
COPY keeper/src /app/src
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-audit --no-fund && \
    npm exec tsc

# ---- runtime ----
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY keeper/package.json /app/package.json

RUN useradd -m -u 10001 tabula && chown -R tabula:tabula /app
USER tabula

EXPOSE 9464
ENV METRICS_PORT=9464 JSON_LOGS=1

HEALTHCHECK --interval=15s --timeout=5s --retries=6 \
  CMD node -e "http=require('http');http.get('http://127.0.0.1:9464/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
