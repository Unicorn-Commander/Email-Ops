#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-${SCRIPT_DIR}/../.env}"
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

DOMAIN="calendar.unicorncommander.ai"
LETSENCRYPT_DIR="${LETSENCRYPT_DIR:-/home/deploy/james-prod/letsencrypt}"
CERTBOT_BIN="${CERTBOT_BIN:-/home/deploy/james-prod/certbot/certbot}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:?set CERTBOT_EMAIL in .env before issuing a certificate}"

log() {
  printf '%s [calendar-cert] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

[[ "${CERTBOT_EMAIL}" != *example.invalid ]] || fail "replace the example.invalid CERTBOT_EMAIL before issuing"

CERT_DIR="${LETSENCRYPT_DIR}/live/${DOMAIN}"
if [[ -s "${CERT_DIR}/fullchain.pem" && -s "${CERT_DIR}/privkey.pem" ]]; then
  log "certificate already exists for ${DOMAIN}; nothing to do"
  exit 0
fi

if [[ ! -x "${CERTBOT_BIN}" ]]; then
  CERTBOT_BIN="$(command -v certbot || true)"
fi
[[ -n "${CERTBOT_BIN}" && -x "${CERTBOT_BIN}" ]] || fail "certbot/certbot not found; set CERTBOT_BIN"

mkdir -p "${LETSENCRYPT_DIR}/work" "${LETSENCRYPT_DIR}/logs"
log "requesting first certificate for ${DOMAIN}"
log "port 80 must be free for certbot standalone; coordinate with jmap-proxy and renew-cert.sh"

exec "${CERTBOT_BIN}" certonly \
  --standalone \
  --preferred-challenges http \
  --non-interactive \
  --agree-tos \
  --keep-until-expiring \
  --email "${CERTBOT_EMAIL}" \
  --cert-name "${DOMAIN}" \
  --config-dir "${LETSENCRYPT_DIR}" \
  --work-dir "${LETSENCRYPT_DIR}/work" \
  --logs-dir "${LETSENCRYPT_DIR}/logs" \
  -d "${DOMAIN}"
