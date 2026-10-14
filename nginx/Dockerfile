# Alpine's Nginx and njs packages are compiled together, avoiding an
# unpinned njs Git checkout and an HTTP download of obsolete Nginx sources.
ARG ALPINE_BASE=alpine:3.22
FROM ${ALPINE_BASE}

RUN apk add --no-cache nginx nginx-mod-http-js gettext-envsubst \
    && mkdir -p /etc/nginx/njs
COPY --chown=nginx:nginx nginx.conf /etc/nginx/nginx.conf.template
COPY --chown=nginx:nginx transform.js /etc/nginx/njs/transform.js
COPY --chown=nginx:nginx entrypoint.sh /usr/local/bin/bridge-entrypoint
RUN chmod 0555 /usr/local/bin/bridge-entrypoint

USER nginx
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/bridge-entrypoint"]
