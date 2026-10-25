#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'usage: %s [base-url] <full-email> <password-file>\n' "$0" >&2
  exit 2
}

BASE_URL="${1:-https://calendar.unicorncommander.ai}"
USER_NAME="${2:-}"
PASSWORD_FILE="${3:-}"
[[ -n "${USER_NAME}" && -n "${PASSWORD_FILE}" ]] || usage
BASE_URL="${BASE_URL%/}"
[[ -r "${PASSWORD_FILE}" ]] || { printf 'password file is not readable: %s\n' "${PASSWORD_FILE}" >&2; exit 2; }

PASSWORD=""
IFS= read -r PASSWORD < "${PASSWORD_FILE}" || true
[[ -n "${PASSWORD}" ]] || { printf 'password file is empty\n' >&2; exit 2; }

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/davis-smoke.XXXXXX")"
NETRC_FILE="${TMP_DIR}/curl.netrc"
HEADERS_FILE="${TMP_DIR}/headers"
BODY_FILE="${TMP_DIR}/body"
MKCALENDAR_FILE="${TMP_DIR}/mkcalendar.xml"
REPORT_FILE="${TMP_DIR}/report.xml"
EVENT_FILE="${TMP_DIR}/event.ics"
SCRATCH_NAME="codex-smoke-$(date -u '+%Y%m%dT%H%M%SZ')-$$"
SCRATCH_CREATED=0
EVENT_CREATED=0

cleanup() {
  set +e
  if [[ "${EVENT_CREATED}" == 1 ]]; then
    "${CURL_AUTH[@]}" -X DELETE "${EVENT_URL:-}" -o /dev/null >/dev/null 2>&1
  fi
  if [[ "${SCRATCH_CREATED}" == 1 ]]; then
    "${CURL_AUTH[@]}" -X DELETE "${CALENDAR_URL:-}" -o /dev/null >/dev/null 2>&1
  fi
  rm -rf -- "${TMP_DIR}"
}
trap cleanup EXIT

AUTH_HOST="$(printf '%s\n' "${BASE_URL}" | sed -E 's#^[A-Za-z][A-Za-z0-9+.-]*://([^/:]+).*#\1#')"
[[ -n "${AUTH_HOST}" && "${AUTH_HOST}" != "${BASE_URL}" ]] || { printf 'base URL must include a host\n' >&2; exit 2; }

# curl reads the password from this mode-0600 netrc file; the password is not
# placed in any curl argument or in the process list.
umask 077
printf 'machine %s\nlogin %s\npassword %s\n' "${AUTH_HOST}" "${USER_NAME}" "${PASSWORD}" > "${NETRC_FILE}"
unset PASSWORD

CURL_COMMON=(curl --silent --show-error --connect-timeout 10 --max-time 60 --path-as-is)
CURL_AUTH=("${CURL_COMMON[@]}" --netrc-file "${NETRC_FILE}")

log() {
  printf '[calendar-smoke] %s\n' "$*"
}

fail_response() {
  local label="$1"
  local status="$2"
  local body="$3"
  printf '[calendar-smoke] ERROR: %s returned HTTP %s\n' "${label}" "${status}" >&2
  sed -n '1,40p' "${body}" >&2 || true
  exit 1
}

require_code() {
  local label="$1"
  local status="$2"
  local allowed="$3"
  local body="$4"
  local expected
  for expected in ${allowed}; do
    [[ "${status}" == "${expected}" ]] && return 0
  done
  fail_response "${label}" "${status}" "${body}"
}

http_status() {
  local output="$1"
  shift
  "$@" -o "${output}" -w '%{http_code}'
}

log 'checking CalDAV well-known redirect'
STATUS="$(http_status /dev/null "${CURL_COMMON[@]}" --max-redirs 0 -D "${HEADERS_FILE}" "${BASE_URL}/.well-known/caldav")"
require_code 'well-known CalDAV redirect' "${STATUS}" '301' /dev/null
grep -Eiq '^location:[[:space:]]*(https?://[^/]+)?/dav/[[:space:]]*$' "${HEADERS_FILE}" ||  # nginx makes relative redirects absolute
  { printf '[calendar-smoke] ERROR: redirect did not point to /dav/\n' >&2; exit 1; }

log 'checking anonymous PROPFIND is rejected'
STATUS="$(http_status "${BODY_FILE}" "${CURL_COMMON[@]}" -X PROPFIND \
  -H 'Depth: 0' -H 'Content-Length: 0' "${BASE_URL}/dav/")"
require_code 'anonymous PROPFIND' "${STATUS}" '401' "${BODY_FILE}"

log "checking authenticated PROPFIND for ${USER_NAME}"
STATUS="$(http_status "${BODY_FILE}" "${CURL_AUTH[@]}" -X PROPFIND \
  -H 'Depth: 0' -H 'Content-Length: 0' "${BASE_URL}/dav/")"
require_code 'authenticated PROPFIND' "${STATUS}" '207' "${BODY_FILE}"

USER_PATH="$(printf '%s' "${USER_NAME}" | sed 's/%/%25/g; s/@/%40/g; s/+/%2B/g; s/ /%20/g')"
# Davis 5.6.2 calendar-home-set is /dav/calendars/<login>/ (measured 2026-10-25).
CALENDAR_BASE_PATH="${DAVIS_CALENDAR_BASE_PATH:-/dav/calendars}"
CALENDAR_PATH="${CALENDAR_BASE_PATH%/}/${USER_PATH}/${SCRATCH_NAME}/"
CALENDAR_URL="${BASE_URL}${CALENDAR_PATH}"
EVENT_ID="${SCRATCH_NAME}.ics"
EVENT_URL="${CALENDAR_URL}${EVENT_ID}"
EVENT_UID="${SCRATCH_NAME}@calendar.unicorncommander.ai"
DTSTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"

printf '%s\n' \
  '<?xml version="1.0" encoding="utf-8" ?>' \
  '<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' \
  '  <D:set>' \
  '    <D:prop>' \
  "      <D:displayname>${SCRATCH_NAME}</D:displayname>" \
  '      <C:calendar-description>Ephemeral Email-Ops smoke test</C:calendar-description>' \
  '      <C:supported-calendar-component-set><C:comp name="VEVENT" /></C:supported-calendar-component-set>' \
  '    </D:prop>' \
  '  </D:set>' \
  '</C:mkcalendar>' > "${MKCALENDAR_FILE}"

log "creating scratch calendar ${SCRATCH_NAME}"
STATUS="$(http_status "${BODY_FILE}" "${CURL_AUTH[@]}" -X MKCALENDAR \
  -H 'Content-Type: application/xml; charset=utf-8' --data-binary "@${MKCALENDAR_FILE}" \
  "${CALENDAR_URL}")"
require_code 'MKCALENDAR' "${STATUS}" '201' "${BODY_FILE}"
SCRATCH_CREATED=1

printf '%s\n' \
  'BEGIN:VCALENDAR' \
  'VERSION:2.0' \
  'PRODID:-//Email-Ops//Davis smoke//EN' \
  'BEGIN:VEVENT' \
  "UID:${EVENT_UID}" \
  "DTSTAMP:${DTSTAMP}" \
  'DTSTART:20300101T120000Z' \
  'DTEND:20300101T130000Z' \
  'SUMMARY:Email-Ops Davis smoke event' \
  'END:VEVENT' \
  'END:VCALENDAR' > "${EVENT_FILE}"

log 'creating scratch event'
STATUS="$(http_status "${BODY_FILE}" "${CURL_AUTH[@]}" -X PUT \
  -H 'Content-Type: text/calendar; charset=utf-8' -H 'If-None-Match: *' \
  --data-binary "@${EVENT_FILE}" "${EVENT_URL}")"
require_code 'PUT event' "${STATUS}" '201 204' "${BODY_FILE}"
EVENT_CREATED=1

printf '%s\n' \
  '<?xml version="1.0" encoding="utf-8" ?>' \
  '<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' \
  '  <D:prop><D:getetag /><C:calendar-data /></D:prop>' \
  "  <D:href>${CALENDAR_PATH}${EVENT_ID}</D:href>" \
  '</C:calendar-multiget>' > "${REPORT_FILE}"

log 'reporting the scratch event'
STATUS="$(http_status "${BODY_FILE}" "${CURL_AUTH[@]}" -X REPORT -H 'Depth: 1' \
  -H 'Content-Type: application/xml; charset=utf-8' --data-binary "@${REPORT_FILE}" \
  "${CALENDAR_URL}")"
require_code 'REPORT' "${STATUS}" '207' "${BODY_FILE}"
grep -Fq "${EVENT_UID}" "${BODY_FILE}" ||
  { printf '[calendar-smoke] ERROR: REPORT did not contain the event UID\n' >&2; exit 1; }

log 'deleting scratch event'
STATUS="$(http_status "${BODY_FILE}" "${CURL_AUTH[@]}" -X DELETE "${EVENT_URL}")"
require_code 'DELETE event' "${STATUS}" '204' "${BODY_FILE}"
EVENT_CREATED=0

log 'deleting scratch calendar'
STATUS="$(http_status "${BODY_FILE}" "${CURL_AUTH[@]}" -X DELETE "${CALENDAR_URL}")"
require_code 'DELETE scratch calendar' "${STATUS}" '204' "${BODY_FILE}"
SCRATCH_CREATED=0

log 'all checks passed'
