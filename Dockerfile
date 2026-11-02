FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

ENV PORT=8080 DATA_DIR=/data NODE_ENV=production

# The app runs as the unprivileged "node" user (uid 1000), so it must own the data directory.
# Named volumes inherit this ownership on first use.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080

USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/session >/dev/null || exit 1
CMD ["node", "server/server.js"]
