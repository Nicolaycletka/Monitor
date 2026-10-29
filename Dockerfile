# --- сборка фронтенда ---
FROM node:22-slim AS web
ARG BASE_PATH=/
ENV BASE_PATH=$BASE_PATH
WORKDIR /app/web
COPY web/package.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# --- рантайм ---
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json ./server/
RUN cd server && npm install --omit=dev && npm cache clean --force
COPY server/ ./server/
COPY --from=web /app/web/dist ./web/dist
ENV NODE_ENV=production PORT=8090 DATA_DIR=/data
EXPOSE 8090
CMD ["node", "server/index.js"]
