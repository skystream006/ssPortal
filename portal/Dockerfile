FROM node:24-alpine AS build
WORKDIR /app
COPY portal/package*.json ./
RUN npm ci --no-audit --no-fund
COPY portal/ ./
RUN npm run build && chown -R node:node /app

FROM node:24-alpine AS dependencies
WORKDIR /app
COPY portal/package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-alpine AS portal
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node portal/server ./server
COPY --chown=node:node portal/config ./config
COPY --chown=node:node portal/package.json ./package.json
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data
USER node
EXPOSE 3000
CMD ["node", "server/index.mjs"]