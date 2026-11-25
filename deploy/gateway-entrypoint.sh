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

printf '\n' > /config/portal-bind-global.caddy
printf '\n' > /config/portal-bind.caddy
if [ "$mode" = local ] && [ -z "$key" ]; then
  address="${DOCKER_BIND_ADDRESS:-127.0.0.1}"
  address="${address#\[}"
  address="${address%\]}"
  case "$address" in
    0.0.0.0|::) address= ;;
    *:*)
      case "$address" in
        *[!0-9a-fA-F:.]*) echo "DOCKER_BIND_ADDRESS must be an IP address" >&2; exit 1 ;;
      esac
      site="https://[$address]"
      ;;
    *[!0-9.]*|'') echo "DOCKER_BIND_ADDRESS must be an IP address" >&2; exit 1 ;;
    *) site="https://$address" ;;
  esac
  if [ -n "$address" ]; then
    printf 'default_sni %s\n' "$address" > /config/portal-bind-global.caddy
    printf '%s {\n  tls internal\n  header -Server\n  redir {$PUBLIC_ORIGIN:https://localhost:4125}{uri} 308\n}\n' "$site" > /config/portal-bind.caddy
  fi
fi

exec caddy "${1:-run}" --config /etc/caddy/Caddyfile --adapter caddyfile