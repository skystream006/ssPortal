FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100 \
    ACADEMY_DB_PATH=/app/data/academy.sqlite \
    PORTAL_INTERNAL_URL=http://portal:3000 \
    PORTAL_THEME_PATH=/app/public/theme.css
COPY portal_apps/ssAcademy/package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node portal_apps/ssAcademy/server ./server
COPY --chown=node:node portal_apps/ssAcademy/public ./public
COPY --chown=node:node portal/src/themes.css ./public/theme.css
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data
USER node
EXPOSE 3100
CMD ["node", "server/index.mjs"]