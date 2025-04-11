ARG BUILD_IMAGE=node:22-slim
ARG RUNTIME_IMAGE=node:22-slim

FROM ${BUILD_IMAGE} AS build
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM ${BUILD_IMAGE} AS deps
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM ${RUNTIME_IMAGE} AS runtime
ARG VERSION=unknown
ARG REVISION=unknown
LABEL org.opencontainers.image.title="fhir-mcp" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.revision="${REVISION}" \
  org.opencontainers.image.source="." \
  org.opencontainers.image.licenses="UNLICENSED"
ENV NODE_ENV=production
ENV FHIR_TRANSPORT=stdio
ENV FHIR_STORE_PATH=/srv/state/state.duckdb
ENV FHIR_ALLOW_WRITE=false
ENV FHIR_LOG_LEVEL=info
WORKDIR /srv
RUN mkdir -p /srv/state && chown node:node /srv/state
COPY --from=deps --chown=node:node /srv/node_modules ./node_modules
COPY --from=build --chown=node:node /srv/dist ./dist
COPY --chown=node:node package.json ./package.json
USER node
VOLUME ["/srv/state"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "dist/tools/cli.js", "health"]
ENTRYPOINT ["node", "dist/host/cli.js"]
