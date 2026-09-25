FROM node:22-bookworm-slim AS build

ENV NODE_OPTIONS=--max-old-space-size=768

WORKDIR /app

RUN npm install --global pnpm@11.5.1

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV FIXAGENT_HOST=0.0.0.0
ENV FIXAGENT_PORT=4174
ENV FIXAGENT_RUNTIME_ROOT=/app/.runtime/cases
ENV NODE_OPTIONS=--max-old-space-size=512

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    bash \
    ca-certificates \
    git \
    python3 \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node public ./public
COPY --chown=node:node skills ./skills

RUN mkdir -p /app/.runtime && chown node:node /app/.runtime

USER node

EXPOSE 4174

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4174/api/models').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
