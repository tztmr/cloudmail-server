#!/usr/bin/env bash
# CloudMail Server Docker 一键部署/运维脚本

set -euo pipefail

if [[ -t 1 ]]; then
  R=$'\033[0;31m'; G=$'\033[0;32m'; Y=$'\033[1;33m'; B=$'\033[0;34m'; NC=$'\033[0m'
else
  R=''; G=''; Y=''; B=''; NC=''
fi

APP_NAME="cloudmail-server"
DEFAULT_WEB_PORT="3000"
DEFAULT_SMTP_PORT="2525"
DEFAULT_GIT_REPO_URL="https://github.com/tztmr/cloudmail-server.git"
if (( EUID == 0 )); then
  DEFAULT_INSTALL_DIR="/opt/cloudmail-server"
else
  DEFAULT_INSTALL_DIR="${HOME}/cloudmail-server"
fi
STATE_DIR="${HOME}/.cloudmail-server"
STATE_FILE="${STATE_DIR}/state.env"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

DRY_RUN=0
ACTION=""
PROJECT_ROOT="$SCRIPT_DIR"
ENV_FILE="$PROJECT_ROOT/.env"
WEB_PORT="$DEFAULT_WEB_PORT"
SMTP_PORT="$DEFAULT_SMTP_PORT"
PROJECT_SOURCE="local"
GIT_REPO_URL="${CLOUDMAIL_REPO_URL:-$DEFAULT_GIT_REPO_URL}"
INSTALL_DIR="${CLOUDMAIL_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
DOCKER_COMPOSE_CMD=()

info() { printf "${B}[INFO]${NC} %s\n" "$1"; }
ok()   { printf "${G}[OK]${NC} %s\n" "$1"; }
warn() { printf "${Y}[WARN]${NC} %s\n" "$1"; }
die()  { printf "${R}[ERROR]${NC} %s\n" "$1" >&2; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

trim() {
  local value="${1:-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

prompt_default() {
  local prompt="$1" def="${2:-}" answer=""
  if [[ -n "$def" ]]; then
    printf '%s [%s]: ' "$prompt" "$def" >&2
  else
    printf '%s: ' "$prompt" >&2
  fi
  read -r answer
  answer="$(trim "$answer")"
  [[ -z "$answer" ]] && answer="$def"
  printf '%s' "$answer"
}

ask_yes_no() {
  local prompt="$1" def="${2:-y}" answer="" hint="[Y/n]"
  [[ "$def" == "n" ]] && hint="[y/N]"
  while true; do
    printf '%s %s: ' "$prompt" "$hint" >&2
    read -r answer
    answer="$(trim "$answer")"
    [[ -z "$answer" ]] && answer="$def"
    answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
    case "$answer" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) warn "请输入 y 或 n" ;;
    esac
  done
}

usage() {
  cat <<'EOF'
用法：
  bash cloudmail.sh [--dry-run] [deploy|status|logs|restart|update|enable-ssl|uninstall|menu]

不带命令时：
  - 交互终端进入菜单
  - 非交互环境执行 deploy
EOF
}

is_project_root() {
  local path="${1:-}"
  [[ -n "$path" && -f "$path/Dockerfile" && -f "$path/docker-compose.yml" ]]
}

while (( $# > 0 )); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    deploy|status|logs|restart|update|enable-ssl|uninstall|menu)
      [[ -n "$ACTION" ]] && die "一次只能执行一个命令"
      ACTION="$1"
      ;;
    *) die "未知参数：$1" ;;
  esac
  shift
done

run_cmd() {
  if (( DRY_RUN )); then
    info "[dry-run] $*"
    return 0
  fi
  "$@"
}

run_shell_cmd() {
  if (( DRY_RUN )); then
    info "[dry-run] $1"
    return 0
  fi
  bash -lc "$1"
}

run_maybe_sudo() {
  if (( EUID == 0 )); then
    run_cmd "$@"
  elif command_exists sudo; then
    if (( DRY_RUN )); then
      info "[dry-run] sudo $*"
      return 0
    fi
    sudo "$@"
  else
    die "需要 root 或 sudo 权限"
  fi
}

run_maybe_sudo_shell() {
  local command="$1"
  if (( EUID == 0 )); then
    run_shell_cmd "$command"
  elif command_exists sudo; then
    if (( DRY_RUN )); then
      info "[dry-run] sudo bash -lc $command"
      return 0
    fi
    sudo bash -lc "$command"
  else
    die "需要 root 或 sudo 权限"
  fi
}

save_state() {
  if (( DRY_RUN )); then
    info "[dry-run] save deploy state to $STATE_FILE"
    return 0
  fi
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR" 2>/dev/null || true
  cat > "$STATE_FILE" <<EOF
PROJECT_ROOT='${PROJECT_ROOT}'
ENV_FILE='${ENV_FILE}'
WEB_PORT='${WEB_PORT}'
SMTP_PORT='${SMTP_PORT}'
PROJECT_SOURCE='${PROJECT_SOURCE}'
GIT_REPO_URL='${GIT_REPO_URL}'
EOF
  chmod 600 "$STATE_FILE" 2>/dev/null || true
}

load_state() {
  [[ -f "$STATE_FILE" ]] || return 1
  set +u
  source "$STATE_FILE"
  set -u
  [[ -d "${PROJECT_ROOT:-}" ]]
}

require_state() {
  load_state || die "未找到部署记录，请先执行 deploy"
  [[ -f "$PROJECT_ROOT/docker-compose.yml" ]] || die "部署记录中的项目目录无效：$PROJECT_ROOT"
}

pick_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD=(docker compose)
  elif command_exists docker-compose; then
    DOCKER_COMPOSE_CMD=(docker-compose)
  else
    die "未找到 docker compose"
  fi
}

install_docker_if_needed() {
  if command_exists docker; then
    pick_compose_cmd
    return 0
  fi
  command_exists curl || die "缺少 curl，无法自动安装 Docker"
  info "未检测到 Docker，开始自动安装..."
  if command_exists apt-get; then
    run_maybe_sudo_shell "curl -fsSL https://get.docker.com | bash"
  elif command_exists dnf; then
    run_maybe_sudo dnf install -y -q dnf-plugins-core
    run_maybe_sudo_shell "dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo"
    run_maybe_sudo dnf install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
  elif command_exists yum; then
    run_maybe_sudo yum install -y -q yum-utils
    run_maybe_sudo_shell "yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo"
    run_maybe_sudo yum install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
  else
    die "缺少 apt-get/dnf/yum，请手动安装 Docker"
  fi
  run_maybe_sudo systemctl enable docker 2>/dev/null || true
  run_maybe_sudo systemctl start docker 2>/dev/null || true
  if (( DRY_RUN )); then
    DOCKER_COMPOSE_CMD=(docker compose)
    return 0
  fi
  pick_compose_cmd
}

install_git_if_needed() {
  if command_exists git; then
    return 0
  fi

  info "未检测到 git，开始自动安装..."
  if command_exists apt-get; then
    run_maybe_sudo apt-get update -y -qq
    run_maybe_sudo apt-get install -y -qq git
  elif command_exists dnf; then
    run_maybe_sudo dnf install -y -q git
  elif command_exists yum; then
    run_maybe_sudo yum install -y -q git
  else
    die "缺少 git，且无法自动安装，请先手动安装 git"
  fi
}

clone_or_update_project() {
  local install_dir="$1"
  PROJECT_SOURCE="git"
  PROJECT_ROOT="$install_dir"

  install_git_if_needed

  if is_project_root "$PROJECT_ROOT"; then
    if [[ -d "$PROJECT_ROOT/.git" ]]; then
      info "检测到已有项目目录，拉取最新代码..."
      (
        cd "$PROJECT_ROOT"
        run_cmd git pull --ff-only
      )
    fi
    return 0
  fi

  if [[ -e "$PROJECT_ROOT" ]]; then
    if [[ -d "$PROJECT_ROOT/.git" ]]; then
      info "检测到已有 Git 仓库，拉取最新代码..."
      (
        cd "$PROJECT_ROOT"
        run_cmd git pull --ff-only
      )
      is_project_root "$PROJECT_ROOT" || die "仓库拉取后仍缺少 Dockerfile/docker-compose.yml：$PROJECT_ROOT"
      return 0
    fi

    if [[ -n "$(find "$PROJECT_ROOT" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]]; then
      die "安装目录已存在且不是 CloudMail 项目：${PROJECT_ROOT}。可设置 CLOUDMAIL_INSTALL_DIR 指定其他目录"
    fi
  fi

  info "当前目录不是项目根目录，开始克隆源码..."
  info "Git 仓库：$GIT_REPO_URL"
  info "安装目录：$PROJECT_ROOT"
  if (( DRY_RUN )); then
    info "[dry-run] git clone $GIT_REPO_URL $PROJECT_ROOT"
    return 0
  fi

  mkdir -p "$(dirname "$PROJECT_ROOT")"
  git clone "$GIT_REPO_URL" "$PROJECT_ROOT"
}

prepare_project_root() {
  if is_project_root "$SCRIPT_DIR"; then
    PROJECT_ROOT="$SCRIPT_DIR"
    PROJECT_SOURCE="local"
    return 0
  fi

  if is_project_root "$PWD"; then
    PROJECT_ROOT="$(cd "$PWD" && pwd)"
    PROJECT_SOURCE="local"
    return 0
  fi

  if load_state && is_project_root "$PROJECT_ROOT"; then
    return 0
  fi

  clone_or_update_project "$INSTALL_DIR"
}

read_env_value() {
  local key="$1"
  local value
  [[ -f "$ENV_FILE" ]] || return 0
  value="$(sed -nE "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*(.*)[[:space:]]*$/\1/p" "$ENV_FILE" | tail -n 1)"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  printf '%s' "$value"
}

detect_env_file() {
  ENV_FILE="$PROJECT_ROOT/.env"
  if [[ ! -f "$ENV_FILE" ]]; then
    if (( DRY_RUN )); then
      info "[dry-run] cp .env.example .env"
    else
      cp "$PROJECT_ROOT/.env.example" "$ENV_FILE"
    fi
    ok "已生成 ${ENV_FILE}，请修改 JWT_SECRET / ADMIN / DOMAIN"
  fi
}

load_ports() {
  local web smtp
  web="$(read_env_value PORT || true)"
  smtp="$(read_env_value SMTP_PUBLIC_PORT || true)"
  if [[ -n "$web" ]]; then
    WEB_PORT="$web"
  fi
  if [[ -n "$smtp" ]]; then
    SMTP_PORT="$smtp"
  fi
  return 0
}

ensure_project_root() {
  if (( DRY_RUN )) && [[ ! -e "$PROJECT_ROOT" ]]; then
    return 0
  fi
  [[ -f "$PROJECT_ROOT/Dockerfile" ]] || die "缺少 Dockerfile：$PROJECT_ROOT"
  [[ -f "$PROJECT_ROOT/docker-compose.yml" ]] || die "缺少 docker-compose.yml：$PROJECT_ROOT"
}

allow_firewall_port() {
  local port="$1"
  if command_exists ufw && ufw status 2>/dev/null | grep -q "Status: active"; then
    run_maybe_sudo ufw allow "${port}/tcp" >/dev/null 2>&1 || true
  fi
  if command_exists firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
    run_maybe_sudo firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null 2>&1 || true
    run_maybe_sudo firewall-cmd --reload >/dev/null 2>&1 || true
  fi
}

compose_up() {
  info "使用环境文件：$ENV_FILE"
  info "Web port: ${WEB_PORT}, SMTP port: ${SMTP_PORT}"
  if (( DRY_RUN )); then
    run_cmd "${DOCKER_COMPOSE_CMD[@]}" up -d --build
    return 0
  fi
  (
    cd "$PROJECT_ROOT"
    run_cmd "${DOCKER_COMPOSE_CMD[@]}" up -d --build
  )
}

print_access_summary() {
  local server_ip
  server_ip="$(curl -s --connect-timeout 5 ifconfig.me 2>/dev/null || true)"
  [[ -z "$server_ip" ]] && server_ip="你的服务器IP"
  echo
  ok "CloudMail Server 已启动"
  echo "Web UI + API: http://${server_ip}:${WEB_PORT}"
  echo "SMTP 接收: ${server_ip}:${SMTP_PORT}"
  echo
  echo "DNS 提醒：MX 记录指向本服务器；生产收信通常把宿主机 25 映射到容器 2525。"
}

deploy() {
  prepare_project_root
  ensure_project_root
  detect_env_file
  load_ports
  install_docker_if_needed
  compose_up
  allow_firewall_port "$WEB_PORT"
  allow_firewall_port "$SMTP_PORT"
  save_state
  print_access_summary
}

status_app() {
  require_state
  pick_compose_cmd
  (
    cd "$PROJECT_ROOT"
    run_cmd "${DOCKER_COMPOSE_CMD[@]}" ps
  )
}

logs_app() {
  require_state
  pick_compose_cmd
  (
    cd "$PROJECT_ROOT"
    run_cmd "${DOCKER_COMPOSE_CMD[@]}" logs -f --tail 150 cloudmail
  )
}

restart_app() {
  require_state
  pick_compose_cmd
  (
    cd "$PROJECT_ROOT"
    run_cmd "${DOCKER_COMPOSE_CMD[@]}" restart cloudmail
  )
}

update_app() {
  require_state
  if [[ "${PROJECT_SOURCE:-local}" == "git" && -d "$PROJECT_ROOT/.git" ]]; then
    info "拉取最新代码..."
    (
      cd "$PROJECT_ROOT"
      run_cmd git pull --ff-only
    )
  fi
  pick_compose_cmd
  detect_env_file
  load_ports
  compose_up
  save_state
  ok "更新完成"
}

enable_ssl() {
  require_state
  local domain email
  domain="$(prompt_default "绑定域名（如 mail.example.com）" "")"
  [[ -n "$domain" ]] || die "域名不能为空"
  email="$(prompt_default "证书邮箱" "admin@${domain}")"

  if ! command_exists nginx; then
    if command_exists apt-get; then
      run_maybe_sudo apt-get update -y -qq
      run_maybe_sudo apt-get install -y -qq nginx
    elif command_exists dnf; then
      run_maybe_sudo dnf install -y -q nginx
    elif command_exists yum; then
      run_maybe_sudo yum install -y -q nginx
    else
      die "请手动安装 nginx"
    fi
  fi

  if ! command_exists certbot; then
    if command_exists apt-get; then
      run_maybe_sudo apt-get install -y -qq certbot python3-certbot-nginx
    elif command_exists dnf; then
      run_maybe_sudo dnf install -y -q certbot python3-certbot-nginx || run_maybe_sudo dnf install -y -q certbot-nginx
    elif command_exists yum; then
      run_maybe_sudo yum install -y -q certbot python3-certbot-nginx || run_maybe_sudo yum install -y -q certbot-nginx
    else
      die "请手动安装 certbot"
    fi
  fi

  local conf_dir="/etc/nginx/conf.d"
  [[ -d "$conf_dir" ]] || conf_dir="/etc/nginx/sites-available"
  run_maybe_sudo_shell "cat > '${conf_dir}/${domain}.conf' <<EOF
server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${WEB_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
    }
}
EOF"
  if [[ -d /etc/nginx/sites-enabled && "$conf_dir" == "/etc/nginx/sites-available" ]]; then
    run_maybe_sudo ln -sf "${conf_dir}/${domain}.conf" "/etc/nginx/sites-enabled/${domain}.conf"
  fi
  run_maybe_sudo nginx -t
  run_maybe_sudo systemctl reload nginx 2>/dev/null || run_maybe_sudo nginx -s reload
  allow_firewall_port 80
  allow_firewall_port 443
  run_maybe_sudo certbot --nginx -d "$domain" --redirect -m "$email" --agree-tos --non-interactive
  ok "HTTPS 已启用：https://${domain}"
}

uninstall_app() {
  require_state
  pick_compose_cmd
  warn "将停止并删除容器，保留项目目录和 Docker 数据卷"
  if [[ ! -t 0 ]] || ask_yes_no "确认继续卸载" "n"; then
    (
      cd "$PROJECT_ROOT"
      run_cmd "${DOCKER_COMPOSE_CMD[@]}" down
    )
    if (( DRY_RUN )); then
      info "[dry-run] rm -f $STATE_FILE"
    else
      rm -f "$STATE_FILE"
    fi
    ok "卸载完成"
  fi
}

print_menu() {
  echo
  echo "========= CloudMail Server 一键脚本 ========="
  echo "1) 一键部署"
  echo "2) 查看状态"
  echo "3) 查看日志"
  echo "4) 重启服务"
  echo "5) 更新应用"
  echo "6) 启用 HTTPS"
  echo "7) 卸载"
  echo "0) 退出"
  echo "============================================="
}

menu_loop() {
  local choice
  while true; do
    print_menu
    printf '请选择 [0-7]: ' >&2
    read -r choice
    choice="$(trim "$choice")"
    case "$choice" in
      1) deploy ;;
      2) status_app ;;
      3) logs_app ;;
      4) restart_app ;;
      5) update_app ;;
      6) enable_ssl ;;
      7) uninstall_app ;;
      0) exit 0 ;;
      *) warn "无效选项" ;;
    esac
  done
}

case "${ACTION:-}" in
  deploy) deploy ;;
  status) status_app ;;
  logs) logs_app ;;
  restart) restart_app ;;
  update) update_app ;;
  enable-ssl) enable_ssl ;;
  uninstall) uninstall_app ;;
  menu) menu_loop ;;
  "")
    if [[ -t 0 ]]; then menu_loop; else deploy; fi
    ;;
esac
