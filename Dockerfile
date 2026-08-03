# --- build ---
FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies so they never reach the runtime image.
RUN npm prune --omit=dev

# --- runtime ---
FROM node:22-alpine

RUN apk add --no-cache tini

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Avatars and the asset cache live here; mount a volume over it.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

ENV NODE_ENV=production \
    FIGURA_HOST=0.0.0.0 \
    FIGURA_PORT=8080 \
    FIGURA_DATA_DIR=/data

EXPOSE 8080
USER node

# tini reaps zombies and forwards SIGTERM, so `docker stop` shuts down cleanly.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FIGURA_PORT||8080)+'/api/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
