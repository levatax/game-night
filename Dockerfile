# Game Night: one container serving the portal, every game client and the multiplayer server.
#   docker build -t game-night .
#   docker run -p 3000:3000 game-night
# Run exactly one replica: rooms and their 4-letter codes live in this process's memory (server/roomCodes.ts).

# ---- build: install everything, build the game clients, compile the servers, then drop dev dependencies
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:server && npm prune --omit=dev

# ---- run: plain node on the compiled hub and game servers (dist/, see tsconfig.server.json)
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 3000
# /healthz answers 503 when a game reports itself unhealthy (GameServerModule.health in server/types.ts) or its
# server failed to register.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
