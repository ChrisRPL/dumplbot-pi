#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_ROOT="${DUMPLBOT_INSTALL_ROOT:-/opt/dumplbot}"
CONFIG_ROOT="${DUMPLBOT_CONFIG_ROOT:-/etc/dumplbot}"
TMP_ROOT="${DUMPLBOT_TMP_ROOT:-/tmp/dumplbot}"
SYSTEMD_ROOT="${DUMPLBOT_SYSTEMD_ROOT:-/etc/systemd/system}"
HEALTHCHECK_INSTALL_PATH="${DUMPLBOT_HEALTHCHECK_PATH:-/usr/local/bin/dumplbot-healthcheck}"
SKIP_APT_BOOTSTRAP="${DUMPLBOT_SKIP_APT_BOOTSTRAP:-0}"
SKIP_NPM_BUILD="${DUMPLBOT_SKIP_NPM_BUILD:-0}"
SKIP_SYSTEMCTL="${DUMPLBOT_SKIP_SYSTEMCTL:-0}"
ALLOW_UNPRIVILEGED="${DUMPLBOT_ALLOW_UNPRIVILEGED:-0}"

path_requires_root() {
  local path_value="$1"

  case "${path_value}" in
    /etc/*|/opt/*|/usr/*|/var/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

needs_root() {
  if [[ "${SKIP_APT_BOOTSTRAP}" != "1" || "${SKIP_SYSTEMCTL}" != "1" ]]; then
    return 0
  fi

  path_requires_root "${INSTALL_ROOT}" && return 0
  path_requires_root "${CONFIG_ROOT}" && return 0
  path_requires_root "${SYSTEMD_ROOT}" && return 0
  path_requires_root "${HEALTHCHECK_INSTALL_PATH}" && return 0

  return 1
}

maybe_reexec_with_sudo() {
  if [[ "${EUID}" -eq 0 ]]; then
    return
  fi

  if [[ "${ALLOW_UNPRIVILEGED}" == "1" ]]; then
    return
  fi

  if ! needs_root; then
    return
  fi

  exec sudo \
    --preserve-env=DUMPLBOT_SERVICE_USER,DUMPLBOT_INSTALL_ROOT,DUMPLBOT_CONFIG_ROOT,DUMPLBOT_TMP_ROOT,DUMPLBOT_SYSTEMD_ROOT,DUMPLBOT_HEALTHCHECK_PATH,DUMPLBOT_SKIP_APT_BOOTSTRAP,DUMPLBOT_SKIP_NPM_BUILD,DUMPLBOT_SKIP_SYSTEMCTL,DUMPLBOT_ALLOW_UNPRIVILEGED \
    bash "$0" "$@"
}

maybe_reexec_with_sudo "$@"

require_command() {
  local command_name="$1"

  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "missing required command: ${command_name}"
    exit 1
  fi
}

require_python_module() {
  local module_name="$1"

  if ! python3 -c "import ${module_name}" >/dev/null 2>&1; then
    echo "missing required python module: ${module_name}"
    exit 1
  fi
}

detect_repo_owner() {
  stat -c '%U' "${REPO_ROOT}" 2>/dev/null \
    || stat -f '%Su' "${REPO_ROOT}" 2>/dev/null \
    || true
}

detect_uid_1000_user() {
  if command -v getent >/dev/null 2>&1; then
    getent passwd 1000 | cut -d: -f1
    return
  fi

  id -un 1000 2>/dev/null || true
}

detect_service_user() {
  if [[ -n "${DUMPLBOT_SERVICE_USER:-}" ]]; then
    printf '%s' "${DUMPLBOT_SERVICE_USER}"
    return
  fi

  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    printf '%s' "${SUDO_USER}"
    return
  fi

  local repo_owner=""
  repo_owner="$(detect_repo_owner)"

  if [[ -n "${repo_owner}" && "${repo_owner}" != "root" ]]; then
    printf '%s' "${repo_owner}"
    return
  fi

  local uid_1000_user=""
  uid_1000_user="$(detect_uid_1000_user)"

  if [[ -n "${uid_1000_user}" ]]; then
    printf '%s' "${uid_1000_user}"
    return
  fi

  echo "could not detect service user; set DUMPLBOT_SERVICE_USER and rerun"
  exit 1
}

bootstrap_os_packages() {
  if [[ "${SKIP_APT_BOOTSTRAP}" == "1" ]]; then
    return
  fi

  require_command apt-get

  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y \
    alsa-utils \
    bubblewrap \
    ca-certificates \
    curl \
    git \
    nodejs \
    npm \
    python3 \
    python3-pil \
    rsync
}

require_minimum_node_major() {
  local minimum_major="$1"
  local node_major=""

  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"

  if [[ -z "${node_major}" || "${node_major}" -lt "${minimum_major}" ]]; then
    echo "node >=${minimum_major} is required; found $(node --version)"
    exit 1
  fi
}

render_service_unit() {
  local source_path="$1"
  local target_path="$2"

  sed \
    -e "s|^User=pi$|User=${SERVICE_USER}|" \
    -e "s|^WorkingDirectory=/opt/dumplbot$|WorkingDirectory=${INSTALL_ROOT}|" \
    -e "s|^EnvironmentFile=-/etc/dumplbot/secrets.env$|EnvironmentFile=-${CONFIG_ROOT}/secrets.env|" \
    -e "/^EnvironmentFile=-${CONFIG_ROOT//\//\\/}\\/secrets.env$/a\\
Environment=DUMPLBOT_CONFIG_PATH=${CONFIG_ROOT}/config.yaml\\
Environment=DUMPLBOT_SECRETS_PATH=${CONFIG_ROOT}/secrets.env\\
Environment=DUMPLBOT_TMP_ROOT=${TMP_ROOT}" \
    -e "s|/opt/dumplbot|${INSTALL_ROOT}|g" \
    "${source_path}" > "${target_path}"
}

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

bootstrap_os_packages
require_command rsync
require_command node
require_command npm
require_command python3
require_command bwrap
require_minimum_node_major 18
require_python_module PIL

SERVICE_USER="$(detect_service_user)"

if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  echo "service user does not exist: ${SERVICE_USER}"
  exit 1
fi

echo "syncing repo into ${INSTALL_ROOT}"
mkdir -p "${INSTALL_ROOT}" "${CONFIG_ROOT}" "${TMP_ROOT}" "${SYSTEMD_ROOT}"
rsync -a \
  --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude .venv \
  "${REPO_ROOT}/" "${INSTALL_ROOT}/"

if [[ "${SKIP_NPM_BUILD}" != "1" ]]; then
  echo "installing node dependencies"
  pushd "${INSTALL_ROOT}" >/dev/null
  npm ci

  echo "building runtime artifacts"
  npm run build
  popd >/dev/null
fi

mkdir -p "${INSTALL_ROOT}/workspaces"
if [[ "${EUID}" -eq 0 ]]; then
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_ROOT}/workspaces" "${TMP_ROOT}"
fi

if [[ ! -f "${CONFIG_ROOT}/config.yaml" ]]; then
  install -m 0644 "${INSTALL_ROOT}/config/dumplbot.example.yaml" "${CONFIG_ROOT}/config.yaml"
  echo "installed ${CONFIG_ROOT}/config.yaml"
fi

if [[ ! -f "${CONFIG_ROOT}/secrets.env" ]]; then
  install -m 0600 /dev/null "${CONFIG_ROOT}/secrets.env"
  echo "created empty ${CONFIG_ROOT}/secrets.env"
fi

render_service_unit "${INSTALL_ROOT}/systemd/dumplbotd.service" "${SYSTEMD_ROOT}/dumplbotd.service"
render_service_unit "${INSTALL_ROOT}/systemd/dumpl-ui.service" "${SYSTEMD_ROOT}/dumpl-ui.service"
install -m 0755 "${INSTALL_ROOT}/scripts/healthcheck.sh" "${HEALTHCHECK_INSTALL_PATH}"

if [[ "${SKIP_SYSTEMCTL}" != "1" ]]; then
  systemctl daemon-reload
fi

SETUP_URL="$(detect_setup_url)"

echo "install complete"
echo "service user: ${SERVICE_USER}"
echo "next:"
echo "  sudo systemctl enable --now dumplbotd.service dumpl-ui.service"
echo "  open ${SETUP_URL} from the same Wi-Fi"
echo "  save provider keys, defaults, and safety mode"
echo "  ${HEALTHCHECK_INSTALL_PATH}"
