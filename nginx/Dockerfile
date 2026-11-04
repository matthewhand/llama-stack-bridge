# Alpine's Nginx and njs packages are compiled together, avoiding an
# unpinned njs Git checkout and an HTTP download of obsolete Nginx sources.
# No default base image, repository or versions: operator MUST approve immutable
# platform-correct base digest and snapshot/pinned package inputs before building.
ARG ALPINE_BASE
FROM ${ALPINE_BASE}
ARG APK_REPOSITORY
ARG NGINX_APK_VERSION
ARG NJS_APK_VERSION
ARG GETTEXT_APK_VERSION

RUN set -eu; \
    case "$APK_REPOSITORY" in https://*) ;; *) exit 2 ;; esac; \
    case "$APK_REPOSITORY" in *[!a-zA-Z0-9._:/?=%+-]*) exit 2 ;; esac; \
    test -n "$NGINX_APK_VERSION" && test -n "$NJS_APK_VERSION" && test -n "$GETTEXT_APK_VERSION"; \
    printf '%s\n' "$APK_REPOSITORY" > /etc/apk/repositories; \
    apk add --no-cache "nginx=$NGINX_APK_VERSION" \
      "nginx-mod-http-js=$NJS_APK_VERSION" \
      "gettext-envsubst=$GETTEXT_APK_VERSION"; \
    mkdir -p /etc/nginx/njs
COPY --chown=nginx:nginx nginx.conf /etc/nginx/nginx.conf.template
COPY --chown=nginx:nginx transform.js /etc/nginx/njs/transform.js
COPY --chown=nginx:nginx entrypoint.sh /usr/local/bin/bridge-entrypoint
RUN chmod 0555 /usr/local/bin/bridge-entrypoint

USER nginx
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/bridge-entrypoint"]
