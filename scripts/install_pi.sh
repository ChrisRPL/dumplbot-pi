#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "run as root"
  exit 1
fi

require_command() {
  local command_name="$1"

  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "missing required command: ${command_name}"
    exit 1
  fi
}

require_command rsync
require_command node
require_command npm

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_ROOT="/opt/dumplbot"
CONFIG_ROOT="/etc/dumplbot"
TMP_ROOT="/tmp/dumplbot"

echo "syncing repo into ${INSTALL_ROOT}"
mkdir -p "${INSTALL_ROOT}" "${CONFIG_ROOT}" "${TMP_ROOT}"
rsync -a \
  --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude .venv \
  "${REPO_ROOT}/" "${INSTALL_ROOT}/"

if [[ ! -f "${CONFIG_ROOT}/config.yaml" ]]; then
  install -m 0644 "${INSTALL_ROOT}/config/dumplbot.example.yaml" "${CONFIG_ROOT}/config.yaml"
  echo "installed ${CONFIG_ROOT}/config.yaml"
fi

if [[ ! -f "${CONFIG_ROOT}/secrets.env" ]]; then
  install -m 0600 /dev/null "${CONFIG_ROOT}/secrets.env"
  echo "created empty ${CONFIG_ROOT}/secrets.env"
fi

install -m 0644 "${INSTALL_ROOT}/systemd/dumplbotd.service" /etc/systemd/system/dumplbotd.service
install -m 0644 "${INSTALL_ROOT}/systemd/dumpl-ui.service" /etc/systemd/system/dumpl-ui.service

systemctl daemon-reload

echo "install complete"
echo "next: populate ${CONFIG_ROOT}/secrets.env, then enable services"
