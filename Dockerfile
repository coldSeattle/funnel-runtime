# Build stage: install deps (with toolchain for the better-sqlite3 native module if no prebuilt
# binary is available), build web + server, then drop dev dependencies.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Runtime stage: same base image, so the compiled native module is binary-compatible.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY configs ./configs
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "dist/server.js"]
