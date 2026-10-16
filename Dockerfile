FROM node:24.16.0-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json LICENSE ./
COPY packages ./packages
COPY apps ./apps
COPY openapi.yaml ./openapi.yaml
RUN npm ci --ignore-scripts --no-audit --no-fund && npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.16.0-alpine
WORKDIR /app
COPY --from=builder /app /app
RUN mkdir -p /app/.data && chown node:node /app/.data
ENV YUMUNIO_HOST=0.0.0.0 YUMUNIO_PORT=8788
EXPOSE 8788
USER node
CMD ["node", "--env-file-if-exists=.env", "apps/server/server.mjs"]
