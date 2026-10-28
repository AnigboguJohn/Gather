# Gather app image: builds the web app, then runs the Node server (API + real-time signal + web).
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server/ ./
COPY --from=web /web/dist /app/web/dist
ENV NODE_ENV=production WEB_DIST=/app/web/dist DATA_DIR=/data PORT=8080
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
