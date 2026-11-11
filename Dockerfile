FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production BIND_HOST=0.0.0.0 PORT=8080 DB_PATH=/app/state/reviews.sqlite
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir state && chown node:node state
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.mjs"]
