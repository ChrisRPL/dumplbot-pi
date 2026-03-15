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
require_command bwrap

detect_setup_url() {
  local first_address=""
  local raw_addresses=""

  raw_addresses="$(hostname -I 2>/dev/null || true)"

  for address in ${raw_addresses}; do
    if [[ "${address}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      first_address="${address}"
      break
    fi
  done

  if [[ -n "${first_address}" ]]; then
    printf "http://%s:4123/setup" "${first_address}"
    return
  fi

  printf "http://<pi-ip>:4123/setup"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_ROOT="/opt/dumplbot"
CONFIG_ROOT="/etc/dumplbot"
TMP_ROOT="/tmp/dumplbot"
SERVICE_USER="pi"

echo "syncing repo into ${INSTALL_ROOT}"
mkdir -p "${INSTALL_ROOT}" "${CONFIG_ROOT}" "${TMP_ROOT}"
rsync -a \
  --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude .venv \
  "${REPO_ROOT}/" "${INSTALL_ROOT}/"

echo "installing node dependencies"
pushd "${INSTALL_ROOT}" >/dev/null
npm ci

echo "building runtime artifacts"
npm run build
popd >/dev/null

mkdir -p "${INSTALL_ROOT}/workspaces"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_ROOT}/workspaces" "${TMP_ROOT}"

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

SETUP_URL="$(detect_setup_url)"

echo "install complete"
echo "next:"
echo "  sudo systemctl enable --now dumplbotd.service dumpl-ui.service"
echo "  open ${SETUP_URL} from the same Wi-Fi"
echo "  save provider keys, defaults, and safety mode"
