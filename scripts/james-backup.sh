#!/usr/bin/env bash
# =============================================================================
# James (MX) backup — your-host. The mail store: james-dev-postgres holds mailboxes
# + message blobs (whole DB ~9MB); james-dev/conf holds Sieve/keystore/config;
# james-dev-data volume holds runtime state. Logical pg_dump (custom, restorable)
# + tarballs, verified, rotated, pushed OFF-DEVICE to your-prod-host over Tailscale.
# =============================================================================
set -euo pipefail
# Fleet encryption lib (P-00084/00956ffc): the pg dump leaves this script only
# as AES-256 .dump.gpg. Passphrase /home/deploy/.fleet-backup-pass; escrow:
# Vaultwarden "UC fleet — DB backup passphrase (your-prod-host+your-host)".
source /home/deploy/backup-lib.sh
TS="$(date +%Y%m%d-%H%M%S)"
DIR="/home/deploy/backups/james"
OFFSITE_SSH="deploy@your-prod-host"
OFFSITE_DIR="/home/deploy/backups/email-ops-offsite/james"
RETENTION_DAYS=14
mkdir -p "${DIR}"
log(){ echo "$(date '+%Y-%m-%d %H:%M:%S') [james-backup] $*"; }
fail(){ log "ERROR: $*"; exit 1; }

docker inspect james-dev-postgres >/dev/null 2>&1 || fail "james-dev-postgres not found"

# 1. Postgres dump (mailboxes + message blobs) — encrypted + verified by the
# lib (full decrypt MDC + pg_restore --list inside james-dev-postgres);
# user/db resolved from the container's POSTGRES_USER/POSTGRES_DB env.
if ! dump_encrypted "james-pg" "james-dev-postgres" "${DIR}" "" "" "james-pg_${TS}.dump"; then
  fail "encrypted pg dump failed"
fi
PGF="${DUMP_ENCRYPTED_ARTIFACT}"
log "pg dump OK: ${PGF} ($(du -h "${PGF}" | cut -f1))"

# 2. Config (Sieve scripts, keystores, mailetcontainer, etc.) — muut-owned bind mount
CFGF="${DIR}/james-conf_${TS}.tar.gz"
tar czf "${CFGF}" --ignore-failed-read --exclude=jmxremote.password --exclude=jmxremote.access -C /home/deploy james-dev/conf 2>/dev/null && log "conf tar OK ($(du -h "${CFGF}" | cut -f1))" || log "WARN: conf tar skipped"

# 3. Runtime data volume (sovereign mailbox store: message bodies + attachments).
# Tar it via a throwaway container (root INSIDE) streaming to stdout, so host-side
# root ownership on the docker volume can't block it — the old direct host-path tar
# ran as muut and silently skipped every backup with "perms". Output stays muut-owned.
DATAF="${DIR}/james-data_${TS}.tar.gz"
if docker run --rm -v james-dev-data:/data:ro alpine tar czf - -C /data . > "${DATAF}" 2>/dev/null \
   && [ -s "${DATAF}" ]; then
  log "data-volume tar OK ($(du -h "${DATAF}" | cut -f1))"
else
  rm -f "${DATAF}"; log "WARN: data-volume tar FAILED (docker/volume)"
fi

# 4. Off-DEVICE push to your-prod-host
if ssh -o BatchMode=yes -o ConnectTimeout=10 "${OFFSITE_SSH}" "mkdir -p '${OFFSITE_DIR}'" 2>/dev/null \
   && rsync -aq -e "ssh -o BatchMode=yes -o ConnectTimeout=10" "${DIR}"/james-*_"${TS}".* "${OFFSITE_SSH}:${OFFSITE_DIR}/" 2>/dev/null; then
  log "off-device push OK -> ${OFFSITE_SSH}:${OFFSITE_DIR}/"
else
  log "WARNING: off-device push failed (local retained)"
fi

# 5. Rotate
find "${DIR}" -name 'james-*' -mtime +"${RETENTION_DAYS}" -delete 2>/dev/null || true
log "done. $(find "${DIR}" -name 'james-pg_*.dump*' | wc -l | tr -d ' ') pg dump(s) retained"
