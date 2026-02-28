#!/usr/bin/env bash
set -euo pipefail

HOST_URL="${DUMPLBOT_HEALTH_URL:-http://127.0.0.1:4123/health}"
failures=0

check_service() {
  local service_name="$1"
  if systemctl is-active --quiet "${service_name}"; then
    echo "[ok] ${service_name}"
  else
    echo "[fail] ${service_name}"
    failures=$((failures + 1))
  fi
}

if command -v curl >/dev/null 2>&1; then
  if curl --fail --silent --show-error "${HOST_URL}" >/dev/null; then
    echo "[ok] health endpoint"
  else
    echo "[fail] health endpoint"
    failures=$((failures + 1))
  fi
else
  echo "[skip] curl missing"
fi

check_service dumplbotd.service
check_service dumpl-ui.service

if [[ "${failures}" -gt 0 ]]; then
  exit 1
fi
