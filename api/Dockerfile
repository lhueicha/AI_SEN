# Node 24 trae SQLite incorporado (node:sqlite): sin compilar nada nativo,
# imagen pequeña y build rápido.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js supabase.js ./

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080
CMD ["node", "server.js"]
