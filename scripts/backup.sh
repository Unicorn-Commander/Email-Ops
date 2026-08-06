#!/usr/bin/env bash
# =============================================================================
# Email-Ops — DB backup (your-host). Covers BOTH stacks: internal + prod.
#   usage: backup.sh <internal|prod>
# Logical pg_dump (custom format) as the OWNER role (BYPASSRLS, captures every
# workspace's rows — the NOBYPASSRLS app role would dump nothing under live RLS),
# verified restorable, rotated locally, pushed off-box to Garage. Mirrors the
# customer-ops/majiks backup idiom. Secrets referenced by env-var name only.
# NOTE: message BODIES live in James, not here — this protects app state
# (workspaces, memberships, mailbox_accounts, message metadata, cleanup batches,
# archive refs). James is backed up separately.
# =============================================================================
set -euo pipefail

STACK="${1:-}"
case "$STACK" in
  internal) CONTAINER="email-ops-postgres";      S3_PREFIX="internal" ;;
  prod)     CONTAINER="email-ops-prod-postgres"; S3_PREFIX="prod" ;;
  *) echo "usage: $0 <internal|prod>"; exit 2 ;;
esac
DB_NAME="emailops"
DB_USER="email_ops_admin"     # OWNER role (BYPASSRLS)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Off-box S3/Garage config (bucket, endpoint, key) — mode-600, gitignored.
[ -f "${SCRIPT_DIR}/.backup.env" ] && { set -a; . "${SCRIPT_DIR}/.backup.env"; set +a; }
# Fleet encryption lib (P-00084/00956ffc): dumps leave this script only as
# AES-256 .dump.gpg. Passphrase /home/deploy/.fleet-backup-pass; escrow:
# Vaultwarden "UC fleet — DB backup passphrase (your-prod-host+your-host)".
source /home/deploy/backup-lib.sh

BACKUP_DIR="/home/deploy/backups/email-ops-db/${S3_PREFIX}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/emailops_${TS}.dump"
LOG_PREFIX="[email-ops-backup:${S3_PREFIX}]"
log(){ echo "$(date '+%Y-%m-%d %H:%M:%S') ${LOG_PREFIX} $*"; }
fail(){ log "ERROR: $*"; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker not on PATH"
docker inspect "${CONTAINER}" >/dev/null 2>&1 || fail "container ${CONTAINER} not found"
mkdir -p "${BACKUP_DIR}"

log "pg_dump ${DB_NAME} (role ${DB_USER}) from ${CONTAINER} (encrypted)..."
# dump_encrypted verifies per run: full decrypt (gpg MDC) + pg_restore --list
# in the db container. Unverified output is deleted and the run fails.
if ! dump_encrypted "email-ops-${S3_PREFIX}" "${CONTAINER}" "${BACKUP_DIR}" "${DB_USER}" "${DB_NAME}" "emailops_${TS}.dump"; then
  fail "encrypted dump failed"
fi
BACKUP_FILE="${DUMP_ENCRYPTED_ARTIFACT}"
log "dump OK: ${BACKUP_FILE} ($(du -h "${BACKUP_FILE}" | cut -f1))"

# Off-box push to Garage (aws-cli container joins unicorn-network to reach it).
if [ -n "${BACKUP_S3_BUCKET:-}" ] && [ -n "${BACKUP_S3_ENDPOINT:-}" ] \
   && [ -n "${BACKUP_S3_ACCESS_KEY_ID:-}" ] && [ -n "${BACKUP_S3_SECRET_ACCESS_KEY:-}" ]; then
  KEY="${S3_PREFIX}/$(basename "${BACKUP_FILE}")"
  if docker run --rm --network "${BACKUP_S3_NETWORK:-unicorn-network}" \
        -e AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY_ID}" \
        -e AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY}" \
        -e AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-us-east-1}" \
        -e AWS_REQUEST_CHECKSUM_CALCULATION=when_required \
        -v "${BACKUP_DIR}:/backups:ro" amazon/aws-cli:latest \
        s3 cp "/backups/$(basename "${BACKUP_FILE}")" "s3://${BACKUP_S3_BUCKET}/${KEY}" \
           --endpoint-url "${BACKUP_S3_ENDPOINT}" >/dev/null 2>&1; then
    log "off-box push OK -> s3://${BACKUP_S3_BUCKET}/${KEY}"
  else
    log "WARNING: off-box push failed (local dump retained)"
  fi
else
  log "off-box target not configured — local-only"
fi

# --- Genuine off-DEVICE copy: rsync to your-prod-host over Tailscale ------------------
if [ -n "${BACKUP_OFFSITE_SSH:-}" ]; then
  DEST="${BACKUP_OFFSITE_DIR:-/home/deploy/backups/email-ops-offsite}/${S3_PREFIX}"
  if ssh -o BatchMode=yes -o ConnectTimeout=10 "${BACKUP_OFFSITE_SSH}" "mkdir -p ${DEST}" 2>/dev/null \
     && rsync -aq -e "ssh -o BatchMode=yes -o ConnectTimeout=10" "${BACKUP_FILE}" "${BACKUP_OFFSITE_SSH}:${DEST}/" 2>/dev/null; then
    log "off-device copy OK -> ${BACKUP_OFFSITE_SSH}:${DEST}/"
  else
    log "WARNING: off-device rsync failed (local + garage copies retained)"
  fi
fi

DEL="$(find "${BACKUP_DIR}" \( -name 'emailops_*.dump' -o -name 'emailops_*.dump.gpg' \) -mtime +"${RETENTION_DAYS}" -print -delete 2>/dev/null | wc -l | tr -d ' ')"
[ "${DEL}" -gt 0 ] && log "rotated ${DEL} old dump(s)"
log "done. $(find "${BACKUP_DIR}" \( -name 'emailops_*.dump' -o -name 'emailops_*.dump.gpg' \) | wc -l | tr -d ' ') local dump(s) retained"
