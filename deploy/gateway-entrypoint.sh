#!/bin/sh
set -eu

mode="${HTTPS_MODE:-local}"
key="${HTTPS_KEY_PATH:-}"
certificate="${HTTPS_CERT_PATH:-}"
policy=/config/portal-tls.caddy

case "$mode" in
  local|public) ;;
  *) echo "HTTPS_MODE must be local or public" >&2; exit 1 ;;
esac

if [ -n "$key" ] || [ -n "$certificate" ]; then
  if [ -z "$key" ] || [ -z "$certificate" ]; then
    echo "HTTPS_KEY_PATH and HTTPS_CERT_PATH must be configured together" >&2
    exit 1
  fi
  for path in "$key" "$certificate"; do
    case "$path" in
      /*) ;;
      *) echo "Certificate paths must be absolute container paths" >&2; exit 1 ;;
    esac
    case "$path" in
      *[!a-zA-Z0-9_./-]*) echo "Certificate paths may contain only letters, digits, underscores, dots, slashes, and hyphens" >&2; exit 1 ;;
    esac
    if [ ! -r "$path" ]; then
      echo "A configured certificate file is not readable" >&2
      exit 1
    fi
  done
  printf 'tls %s %s\n' "$certificate" "$key" > "$policy"
elif [ "$mode" = public ]; then
  printf '\n' > "$policy"
else
  printf 'tls internal\n' > "$policy"
fi

exec caddy "${1:-run}" --config /etc/caddy/Caddyfile --adapter caddyfile