ARG DENO_IMAGE=denoland/deno:alpine-2.5.6@sha256:b9c7668c78fe393893f00b0fc8ba3d0f2e1bbb8f891a79a963b3b713ab110767

FROM ${DENO_IMAGE} AS build
WORKDIR /app
COPY deno.json deno.lock ./
COPY e2e-payments/ e2e-payments/
COPY src/ src/
COPY scripts/ scripts/
RUN deno install && deno task build:static

FROM ${DENO_IMAGE}
ARG SOURCE_COMMIT=unknown
WORKDIR /app

LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.source="https://github.com/KevinDelta/tickets"

# Create non-root user for running the application
RUN addgroup -S tickets && adduser -S tickets -G tickets \
    && mkdir -p /data && chown tickets:tickets /data

COPY --from=build /app/deno.json /app/deno.lock ./
COPY --from=build /app/e2e-payments/ e2e-payments/
COPY --from=build /app/src/ src/
RUN deno cache src/index.ts

VOLUME /data
EXPOSE 3000

ENV DB_URL="file:/data/tickets.db"

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["deno", "eval", "const r = await fetch('http://localhost:3000/health'); if (!r.ok) Deno.exit(1);"]

USER tickets

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write=/data", "--allow-sys", "--allow-ffi", "src/index.ts"]
