ARG NODE_IMAGE=node:24.22.0-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package.json package-lock.json LICENSE ./
COPY packages ./packages
COPY apps ./apps
COPY openapi.yaml ./openapi.yaml
RUN npm ci --ignore-scripts --no-audit --no-fund && npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund && rm -rf apps/web/.next apps/web/out

FROM ${NODE_IMAGE}
# Keep OS security fixes current. Runtime starts with node directly and does not need npm/Corepack.
RUN apk upgrade --no-cache && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=builder /app /app
RUN mkdir -p /app/.data && chown node:node /app/.data
ENV YUMUNIO_HOST=0.0.0.0 YUMUNIO_PORT=8788 YUMUNIO_STORAGE=sqlite YUMUNIO_WEB_SETUP=true YUMUNIO_BLOB_DRIVER=local
EXPOSE 8788
USER node
CMD ["node", "--env-file-if-exists=.env", "apps/server/server.mjs"]
