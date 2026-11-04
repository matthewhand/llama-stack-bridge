#!/bin/sh
set -eu

: "${UPSTREAM_HOST:?Set UPSTREAM_HOST in .env}"
: "${UPSTREAM_PORT:?Set UPSTREAM_PORT in .env}"

# Keep the startup mode intact while temporarily splitting host labels.
entrypoint_mode=${1:-}
# Fail closed before interpolating an upstream into an Nginx directive.
# Allow only DNS host labels or canonical dotted-decimal IPv4; no URLs or IPv6.
invalid_host() {
  echo "Invalid UPSTREAM_HOST (DNS name or IPv4 only)" >&2
  exit 2
}
case "$UPSTREAM_HOST" in
  ""|.*|*.|*..*|*[!a-zA-Z0-9.-]*) invalid_host ;;
esac
[ "${#UPSTREAM_HOST}" -le 253 ] || invalid_host
# Split on periods only after disallowing metacharacters, empty labels and globbing.
set -f
old_ifs=$IFS
IFS=.
set -- $UPSTREAM_HOST
IFS=$old_ifs
all_numeric=true
for label do
  [ "${#label}" -le 63 ] || invalid_host
  case "$label" in ""|-*|*-) invalid_host ;; esac
  case "$label" in *[!0-9]*) all_numeric=false ;; esac
done
if [ "$all_numeric" = true ]; then
  # All-digit dotted names are IP addresses, never ambiguous DNS aliases.
  [ "$#" -eq 4 ] || invalid_host
  for octet do
    case "$octet" in 0|[1-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5]) ;;
      *) invalid_host ;;
    esac
  done
fi
case "$UPSTREAM_PORT" in
  ""|*[!0-9]*) echo "Invalid UPSTREAM_PORT" >&2; exit 2 ;;
esac
if [ "${#UPSTREAM_PORT}" -gt 5 ] || [ "$UPSTREAM_PORT" -lt 1 ] || [ "$UPSTREAM_PORT" -gt 65535 ]; then
  echo "UPSTREAM_PORT must be 1..65535" >&2
  exit 2
fi

# Resolve once at startup through musl getent (including Docker extra_hosts).
# ngx.fetch requires a numeric URL here; the original name remains its Host header.
valid_ipv4() {
  case "$1" in ""|*[!0-9.]*|.*|*.) return 1 ;; esac
  old_ifs=$IFS
  IFS=.
  set -- $1
  IFS=$old_ifs
  [ "$#" -eq 4 ] || return 1
  for octet do
    case "$octet" in 0|[1-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5]) ;; *) return 1 ;; esac
  done
}
UPSTREAM_IP=$(getent ahostsv4 "$UPSTREAM_HOST" | awk 'NR == 1 { print $1; exit }')
valid_ipv4 "$UPSTREAM_IP" || {
  echo "Unable to resolve UPSTREAM_HOST to IPv4" >&2
  exit 2
}
export UPSTREAM_IP

# Only substitute our three validated values; preserve Nginx's own $variables.
envsubst '$UPSTREAM_HOST $UPSTREAM_IP $UPSTREAM_PORT' \
  < /etc/nginx/nginx.conf.template > /tmp/llama-stack-bridge.conf
nginx -e stderr -t -c /tmp/llama-stack-bridge.conf
# One-shot preflight: validate only, without starting Nginx workers.
if [ "$entrypoint_mode" = "--check" ]; then
  exit 0
fi
exec nginx -e stderr -c /tmp/llama-stack-bridge.conf -g 'daemon off;'
