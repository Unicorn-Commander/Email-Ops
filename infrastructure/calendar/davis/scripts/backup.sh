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

BACKUP_HOST="${BACKUP_HOST:-$(hostname -s)}"
BACKUP_HOST="$(printf '%s' "${BACKUP_HOST}" | tr -cd '[:alnum:]._-')"
BACKUP_DIR="${BACKUP_DIR:-/home/deploy/backups/mail-calendar}"
RETENTION_COUNT="${BACKUP_RETENTION_COUNT:-14}"
BACKUP_RSYNC_TARGET="${BACKUP_RSYNC_TARGET:-}"
JAMES_CONTAINER="${JAMES_POSTGRES_CONTAINER:-james-prod-postgres}"
DAVIS_CONTAINER="${DAVIS_POSTGRES_CONTAINER:-davis-postgres}"
JAMES_DB="${JAMES_POSTGRES_DB:-${JAMES_DB:-}}"
JAMES_USER="${JAMES_POSTGRES_USER:-${JAMES_USER:-}}"
DAVIS_DB="${DAVIS_POSTGRES_BACKUP_DB:-${DAVIS_POSTGRES_DB:-${DAVIS_DB:-}}}"
DAVIS_USER="${DAVIS_POSTGRES_BACKUP_USER:-${DAVIS_POSTGRES_USER:-${DAVIS_USER:-}}}"
DAVIS_DATABASE_ENGINE="${DAVIS_DATABASE_ENGINE:-postgresql}"
TS="$(date -u '+%Y%m%dT%H%M%SZ')"
LAST_DUMP=""

log() {
  printf '%s [mail-calendar-backup] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

require_value() {
  local name="$1"
  local value="$2"
  [[ -n "${value}" ]] || fail "${name} is not set"
  [[ "${value}" != CHANGE_ME* ]] || fail "${name} still contains a CHANGE_ME placeholder"
}

[[ "${BACKUP_HOST}" != "" ]] || fail "BACKUP_HOST produced an empty filename prefix"
[[ "${RETENTION_COUNT}" =~ ^[1-9][0-9]*$ ]] || fail "BACKUP_RETENTION_COUNT must be a positive integer"
require_value JAMES_POSTGRES_DB "${JAMES_DB}"
require_value JAMES_POSTGRES_USER "${JAMES_USER}"
require_value DAVIS_DATABASE_NAME "${DAVIS_DB}"
require_value DAVIS_DATABASE_USER "${DAVIS_USER}"

case "${DAVIS_DATABASE_ENGINE}" in
  postgresql|postgres|postgresql*)
    DAVIS_DATABASE_ENGINE=postgresql
    ;;
  mariadb|mysql)
    DAVIS_DATABASE_ENGINE=mariadb
    ;;
  *)
    fail "DAVIS_DATABASE_ENGINE must be postgresql or mariadb"
    ;;
esac

umask 077
mkdir -p "${BACKUP_DIR}"

require_running_container() {
  local container="$1"
  local running
  running="$(docker inspect --format '{{.State.Running}}' "${container}" 2>/dev/null || true)"
  [[ "${running}" == true ]] || fail "container ${container} is not running"
}

dump_postgres() {
  local label="$1"
  local container="$2"
  local db="$3"
  local user="$4"
  local db_component
  local output

  db_component="$(printf '%s' "${db}" | tr -cd '[:alnum:]._-')"
  [[ -n "${db_component}" ]] || fail "database name produced an empty filename component"
  output="${BACKUP_DIR}/${BACKUP_HOST}_${db_component}_${TS}.dump"

  require_running_container "${container}"
  log "dumping ${label} PostgreSQL database ${db} from ${container}"
  if ! docker exec "${container}" pg_dump -Fc --username="${user}" --dbname="${db}" > "${output}"; then
    rm -f -- "${output}"
    fail "pg_dump failed for ${label}"
  fi
  [[ -s "${output}" ]] || { rm -f -- "${output}"; fail "empty dump for ${label}"; }
  log "${label} dump OK: ${output} ($(du -h "${output}" | cut -f1))"
  LAST_DUMP="${output}"
}

dump_mariadb() {
  local label="$1"
  local container="$2"
  local db="$3"
  local user="$4"
  local db_component
  local output

  db_component="$(printf '%s' "${db}" | tr -cd '[:alnum:]._-')"
  [[ -n "${db_component}" ]] || fail "database name produced an empty filename component"
  output="${BACKUP_DIR}/${BACKUP_HOST}_${db_component}_${TS}.sql"

  require_running_container "${container}"
  log "dumping ${label} MariaDB database ${db} from ${container}"
  # The fallback cannot produce a PostgreSQL custom archive. It remains
  # gzip-free and is plain SQL so the restore instructions can replay it.
  if ! docker exec "${container}" sh -ec \
    'mariadb-dump --single-transaction --routines --events --triggers --user="$1" --password="$MARIADB_PASSWORD" --databases "$2"' \
    sh "${user}" "${db}" > "${output}"; then
    rm -f -- "${output}"
    fail "mariadb-dump failed for ${label}"
  fi
  [[ -s "${output}" ]] || { rm -f -- "${output}"; fail "empty dump for ${label}"; }
  log "${label} dump OK: ${output} ($(du -h "${output}" | cut -f1))"
  LAST_DUMP="${output}"
}

rotate_label() {
  local label="$1"
  local component
  local files=()
  local file
  local index

  component="$(printf '%s' "${label}" | tr -cd '[:alnum:]._-')"
  [[ -n "${component}" ]] || fail "database name produced an empty rotation component"

  while IFS= read -r file; do
    files[${#files[@]}]="${file}"
  done < <(find "${BACKUP_DIR}" -maxdepth 1 -type f \
    \( -name "${BACKUP_HOST}_${component}_*.dump" -o -name "${BACKUP_HOST}_${component}_*.sql" \) \
    -print | sort -r)

  if (( ${#files[@]} > RETENTION_COUNT )); then
    for ((index=RETENTION_COUNT; index<${#files[@]}; index++)); do
      rm -f -- "${files[${index}]}"
    done
  fi
}

dump_postgres james "${JAMES_CONTAINER}" "${JAMES_DB}" "${JAMES_USER}"
JAMES_DUMP="${LAST_DUMP}"
if [[ "${DAVIS_DATABASE_ENGINE}" == mariadb ]]; then
  dump_mariadb davis "${DAVIS_CONTAINER}" "${DAVIS_DB}" "${DAVIS_USER}"
else
  dump_postgres davis "${DAVIS_CONTAINER}" "${DAVIS_DB}" "${DAVIS_USER}"
fi
DAVIS_DUMP="${LAST_DUMP}"

rotate_label "${JAMES_DB}"
rotate_label "${DAVIS_DB}"

if [[ -n "${BACKUP_RSYNC_TARGET}" ]]; then
  log "copying current dumps off-box with rsync"
  if ! rsync -a -- "${JAMES_DUMP}" "${DAVIS_DUMP}" "${BACKUP_RSYNC_TARGET%/}/"; then
    fail "rsync to BACKUP_RSYNC_TARGET failed"
  fi
  log "off-box copy OK"
else
  log "WARNING: BACKUP_RSYNC_TARGET is empty; off-box copy skipped"
fi

log "done; retained up to ${RETENTION_COUNT} newest dump(s) per database"
