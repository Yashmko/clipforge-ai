FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg \
  fonts-dejavu-core \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN npm install -g corepack@latest && corepack pnpm install --frozen-lockfile

ENV NODE_ENV=production
CMD ["corepack", "pnpm", "exec", "tsx", "render-worker/index.ts"]
