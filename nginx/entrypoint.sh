#!/bin/sh
set -eu

: "${UPSTREAM_HOST:?Set UPSTREAM_HOST in .env}"
: "${UPSTREAM_PORT:?Set UPSTREAM_PORT in .env}"

# Never interpolate arbitrary text into Nginx configuration.
case "$UPSTREAM_HOST" in
  ""|.*|-*|*[!a-zA-Z0-9_.-]*)
    echo "Invalid UPSTREAM_HOST (DNS name or IPv4 only)" >&2
    exit 2
    ;;
esac
if [ "${#UPSTREAM_HOST}" -gt 253 ]; then
  echo "UPSTREAM_HOST is too long" >&2
  exit 2
fi
case "$UPSTREAM_PORT" in
  ""|*[!0-9]*)
    echo "Invalid UPSTREAM_PORT" >&2
    exit 2
    ;;
esac
if [ "${#UPSTREAM_PORT}" -gt 5 ] || [ "$UPSTREAM_PORT" -lt 1 ] || [ "$UPSTREAM_PORT" -gt 65535 ]; then
  echo "UPSTREAM_PORT must be 1..65535" >&2
  exit 2
fi

# Only substitute our two values; preserve Nginx's own $variables.
envsubst '$UPSTREAM_HOST $UPSTREAM_PORT' \
  < /etc/nginx/nginx.conf.template > /tmp/llama-stack-bridge.conf
nginx -t -c /tmp/llama-stack-bridge.conf
exec nginx -c /tmp/llama-stack-bridge.conf -g 'daemon off;'
