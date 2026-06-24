FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
COPY scripts ./scripts
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && npm ci \
  && rm -rf /var/lib/apt/lists/* /root/.npm

COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS deps
WORKDIR /app

COPY package*.json ./
COPY scripts ./scripts
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && npm ci --omit=dev \
  && apt-get purge -y --auto-remove python3 make g++ \
  && rm -rf /var/lib/apt/lists/* /root/.npm

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3000 \
  SCREEN_PLUS_STATE_DIR=/data \
  SCREEN_PLUS_CONFIG=/data/config.json \
  SCREEN_PLUS_SCREENRC=/app/screen-plus.screenrc \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8

RUN apt-get update \
  && apt-get install -y --no-install-recommends screen tini ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server ./server
COPY screen-plus.screenrc package*.json ./
COPY docker-entrypoint.sh /usr/local/bin/screen-plus-entrypoint

RUN chmod +x /usr/local/bin/screen-plus-entrypoint \
  && chown -R node:node /app /data

USER node
VOLUME ["/data"]
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "screen-plus-entrypoint"]
CMD ["npm", "start"]
