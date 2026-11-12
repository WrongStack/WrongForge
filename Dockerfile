# WrongForge container image.
#
# Runs the TS source directly under tsx (no bun compile needed): the runtime
# stage carries node_modules + src + the built dashboard (webui/dist). The
# server inside a container is a NON-compiled binary by design — the
# self-update paths stay off (image pulls are how you update) and everything
# else (tasks, sessions, queue, keep-alive, MCP, proxy) is identical.
#
#   docker build -t wrongforge .
#   docker run -p 8787:8787 -v wrongforge-data:/data wrongforge
#
# State lives in /data (WRONGFORGE_HOME): OAuth tokens, api-key, task and
# session stores, logs. Mount a volume or you lose sign-in on every restart.
#
#   npm ci on the build stage is deterministic (lockfile); webui deps are
#   installed separately because the dashboard has its own package.json.

# ---------------- build: deps + dashboard ----------------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY webui/package.json webui/package-lock.json webui/
RUN npm ci --no-audit --no-fund && npm --prefix webui ci --no-audit --no-fund
COPY . .
RUN npm --prefix webui run build

# ---------------- runtime ----------------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    WRONGFORGE_HOME=/data \
    PORT=8787 \
    # a container is a network endpoint: published ports must reach the
    # listener (override with -e HOST=127.0.0.1 if you really want local-only)
    HOST=0.0.0.0 \
    NO_COLOR=1
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./
COPY --from=build /app/webui/dist ./webui/dist
EXPOSE 8787
VOLUME /data
# /health is the only unauthenticated route — perfect for a healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["npx", "tsx", "src/main.ts", "serve"]
