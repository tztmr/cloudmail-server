#!/usr/bin/env bash
# CloudMail Server (cloudmail_server) Docker 一键部署/运维脚本
# 学习自 cloudmail-open-receiver.sh 的优秀结构（菜单、状态持久化、dry-run、sudo 封装、nginx+certbot 等）
# 针对本项目适配：Web 3000 + 内置 SMTP 接收、自动 schema、只收不发模式友好
#
# 只接收邮件场景优化：
#   - 交互时可选择“只收模式”
#   - 自动提示 MX + 安全组 25 端口配置
#   - 推荐对象存储存附件
#
# 用法：
#   chmod +x cloudmail.sh
#   bash cloudmail.sh                 # 交互终端进入菜单，否则执行 deploy
#   bash cloudmail.sh deploy
#   bash cloudmail.sh status
#   bash cloudmail.sh --dry-run deploy
#
# 支持命令：deploy | status | logs | restart | update | enable-ssl | uninstall | menu

set -euo pipefail

if [[ -t 1 ]]; then
  R=$'\033[0;31m'; G=$'\033[0;32m'; Y=$'\033[1;33m'; B=$'\033[0;34m'; NC=$'\033[0m'
else
  R=''; G=''; Y=''; B=''; NC=''
fi

DEFAULT_APP_NAME="cloudmail"
DEFAULT_WEB_PORT="3000"
DEFAULT_SMTP_PORT="2525"
DEFAULT_HOSTNAME="0.0.0.0"
DEFAULT_GIT_REPO_URL="https://github.com/tztmr/cloudmail-server.git"
DEFAULT_INSTALL_DIR="${HOME}/cloudmail-server"
STATE_DIR="${HOME}/.cloudmail-server"
STATE_FILE="${STATE_DIR}/state.env"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

DRY_RUN=0
ACTION=""
APP_NAME="$DEFAULT_APP_NAME"
PROJECT_ROOT="$SCRIPT_DIR"
ENV_FILE=""
WEB_PORT="$DEFAULT_WEB_PORT"
SMTP_PORT="$DEFAULT_SMTP_PORT"
APP_HOSTNAME="$DEFAULT_HOSTNAME"
PROJECT_SOURCE="local"
GIT_REPO_URL="$DEFAULT_GIT_REPO_URL"
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

expand_path() {
  local path="${1:-}"
  case "$path" in
    "~") printf '%s' "$HOME" ;;
    "~"/*) printf '%s/%s' "$HOME" "${path#~/}" ;;
    *) printf '%s' "$path" ;;
  esac
}

is_interactive() {
  [[ -t 0 && -t 1 ]]
}

portable_sed_inplace() {
  local expr="$1" file="$2"
  if sed --version >/dev/null 2>&1; then
    sed -i -e "$expr" "$file"
  else
    sed -i '' -e "$expr" "$file"
  fi
}

escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'
}

set_env_value() {
  local key="$1" value="$2" escaped_value=""
  [[ -n "${ENV_FILE:-}" ]] || die "ENV_FILE 未设置，无法写入 ${key}"

  escaped_value="$(escape_sed_replacement "$value")"
  if grep -Eq "^[[:space:]]*${key}[[:space:]]*=" "$ENV_FILE"; then
    portable_sed_inplace "s|^[[:space:]]*${key}[[:space:]]*=.*$|${key}=${escaped_value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

env_has_placeholder_values() {
  [[ -f "${ENV_FILE:-}" ]] || return 1
  grep -Eq '^JWT_SECRET=请替换为至少32位强随机字符串$|^ADMIN=admin@yourdomain\.com$|^DOMAIN=\["yourdomain\.com"\]$' "$ENV_FILE"
}

is_valid_project_root() {
  local path="${1:-}"
  [[ -n "$path" ]] || return 1
  [[ -d "$path" && -f "$path/docker-compose.yml" && -f "$path/Dockerfile" ]]
}

discover_local_project_root() {
  local candidate=""
  for candidate in \
    "$SCRIPT_DIR" \
    "$PWD" \
    "$HOME/cloudmail-server" \
    "$HOME/cloudmail_server" \
    "/opt/cloudmail-server" \
    "/opt/cloudmail_server"; do
    if is_valid_project_root "$candidate"; then
      PROJECT_ROOT="$(cd "$candidate" && pwd)"
      PROJECT_SOURCE="local"
      return 0
    fi
  done
  return 1
}

prompt_for_project_root() {
  local answer=""
  answer="$(prompt_default "项目代码目录（留空则自动克隆到 ${DEFAULT_INSTALL_DIR}）" "")"
  answer="$(trim "$answer")"
  [[ -n "$answer" ]] || return 1

  answer="$(expand_path "$answer")"
  is_valid_project_root "$answer" || die "项目目录无效：${answer}（需要包含 docker-compose.yml 和 Dockerfile）"

  PROJECT_ROOT="$(cd "$answer" && pwd)"
  PROJECT_SOURCE="local"
}

repair_project_root() {
  prompt_for_project_root || die "未提供可用的项目目录"
  ensure_project_root
  detect_env_file
  detect_public_ports
  save_state
  ok "项目目录已修复：$PROJECT_ROOT"
}

ensure_state_dir() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR" 2>/dev/null || true
}

save_state() {
  ensure_state_dir
  cat > "$STATE_FILE" <<EOF
PROJECT_ROOT='${PROJECT_ROOT}'
ENV_FILE='${ENV_FILE}'
APP_NAME='${APP_NAME}'
WEB_PORT='${WEB_PORT}'
SMTP_PORT='${SMTP_PORT}'
APP_HOSTNAME='${APP_HOSTNAME}'
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
  [[ -n "${PROJECT_ROOT:-}" && -n "${APP_NAME:-}" ]]
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
CloudMail Server 一键部署脚本

用法：
  bash cloudmail.sh [--dry-run] [deploy|status|logs|restart|update|enable-ssl|repair-project|uninstall|menu]

不带子命令时：
  - 交互式终端：进入菜单
  - 非交互：执行 deploy

常用示例：
  bash cloudmail.sh deploy
  bash cloudmail.sh status
  bash cloudmail.sh logs
  bash cloudmail.sh --dry-run update
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    deploy|status|logs|restart|update|enable-ssl|repair-project|uninstall|menu)
      [[ -n "$ACTION" ]] && die "一次只能执行一个命令"
      ACTION="$1"
      ;;
    *)
      die "未知参数：$1"
      ;;
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

detect_env_file() {
  # 优先使用项目根的 .env，其次 mail-worker/.env.example 生成
  if [[ -f "$PROJECT_ROOT/.env" ]]; then
    ENV_FILE="$PROJECT_ROOT/.env"
  elif [[ -f "$PROJECT_ROOT/mail-worker/.env.example" ]]; then
    ENV_FILE="$PROJECT_ROOT/.env"
    if (( DRY_RUN )); then
      info "[dry-run] 从 mail-worker/.env.example 生成 $ENV_FILE"
    else
      cp "$PROJECT_ROOT/mail-worker/.env.example" "$ENV_FILE"
      # 给关键变量加提示
      set_env_value "JWT_SECRET" "请替换为至少32位强随机字符串"
      set_env_value "ADMIN" "admin@yourdomain.com"
      set_env_value "DOMAIN" '["yourdomain.com"]'
    fi
    ok "已生成 $ENV_FILE，请务必修改 JWT_SECRET / ADMIN / DOMAIN"
  else
    # 兜底在根目录创建一个最小 .env
    ENV_FILE="$PROJECT_ROOT/.env"
    if (( DRY_RUN )); then
      info "[dry-run] 生成基础 $ENV_FILE"
    else
      cat > "$ENV_FILE" <<'EOT'
JWT_SECRET=请替换为至少32位强随机字符串
ADMIN=admin@yourdomain.com
DOMAIN=["yourdomain.com"]
PORT=3000
SMTP_ENABLED=true
SMTP_PORT=2525
DATA_DIR=/app/data
EOT
    fi
    ok "已创建 $ENV_FILE，请修改关键配置"
  fi
}

read_env_value() {
  local key="$1"
  local value
  value="$(
    sed -nE "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*(.*)[[:space:]]*$/\1/p" "$ENV_FILE" | tail -n 1
  )"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  printf '%s' "$value"
}

load_runtime_env() {
  WEB_PORT="$DEFAULT_WEB_PORT"
  SMTP_PORT="$DEFAULT_SMTP_PORT"
  APP_HOSTNAME="$DEFAULT_HOSTNAME"

  local p s
  p="$(read_env_value PORT || true)"
  s="$(read_env_value SMTP_PORT || true)"

  [[ -n "$p" ]] && WEB_PORT="$p"
  [[ -n "$s" ]] && SMTP_PORT="$s"
}

ensure_project_root() {
  [[ -d "$PROJECT_ROOT" ]] || die "项目目录不存在：$PROJECT_ROOT"
  [[ -f "$PROJECT_ROOT/docker-compose.yml" ]] || die "缺少 docker-compose.yml：$PROJECT_ROOT"
  [[ -f "$PROJECT_ROOT/Dockerfile" ]] || die "缺少 Dockerfile：$PROJECT_ROOT"
}

require_state() {
  load_state || die "未找到部署记录，请先执行 deploy"
  ensure_project_root
}

clone_or_update_repo() {
  local install_dir="$1"
  GIT_REPO_URL="${GIT_REPO_URL:-$DEFAULT_GIT_REPO_URL}"
  PROJECT_SOURCE="git"
  PROJECT_ROOT="$install_dir"

  if [[ -d "${PROJECT_ROOT}/.git" ]]; then
    info "检测到已有仓库，拉取最新代码..."
    (
      cd "$PROJECT_ROOT"
      run_cmd git pull --ff-only
    )
  else
    info "开始从 Git 克隆项目..."
    run_cmd git clone "$GIT_REPO_URL" "$PROJECT_ROOT"
  fi
}

pick_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD=(docker compose)
  elif command_exists docker-compose; then
    DOCKER_COMPOSE_CMD=(docker-compose)
  else
    die "未找到 docker compose（请安装 Docker）"
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
    die "请手动安装 Docker（apt/dnf/yum 均未检测到）"
  fi

  run_maybe_sudo systemctl enable docker 2>/dev/null || true
  run_maybe_sudo systemctl start docker 2>/dev/null || true
  pick_compose_cmd
}

detect_public_ports() {
  # 从 docker-compose.yml 提取对外端口
  local detected
  detected="$(
    sed -nE 's/^[[:space:]]*-[[:space:]]*"?([0-9]+):[0-9]+"?[[:space:]]*$/\1/p' \
      "$PROJECT_ROOT/docker-compose.yml" | sort -n | head -n 2
  )"
  if [[ -n "$detected" ]]; then
    WEB_PORT=$(echo "$detected" | head -n 1)
    SMTP_PORT=$(echo "$detected" | tail -n 1)
  else
    WEB_PORT="$DEFAULT_WEB_PORT"
    SMTP_PORT="$DEFAULT_SMTP_PORT"
  fi
}

allow_firewall_port() {
  local port="$1"
  if command_exists ufw; then
    if ufw status 2>/dev/null | grep -q "Status: active"; then
      run_maybe_sudo ufw allow "${port}/tcp" >/dev/null 2>&1 || true
    fi
  fi
  if command_exists firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
    run_maybe_sudo firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null 2>&1 || true
    run_maybe_sudo firewall-cmd --reload >/dev/null 2>&1 || true
  fi
}

nginx_conf_dir() {
  if [[ -n "${NGINX_CONF_DIR:-}" ]]; then
    printf '%s' "$NGINX_CONF_DIR"
  elif [[ -d /etc/nginx/conf.d ]]; then
    printf '/etc/nginx/conf.d'
  else
    printf '/etc/nginx/sites-available'
  fi
}

install_nginx_if_needed() {
  if command_exists nginx; then return 0; fi
  info "未检测到 nginx，开始安装..."
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
}

install_certbot_if_needed() {
  if command_exists certbot; then return 0; fi
  info "未检测到 certbot，开始安装..."
  if command_exists apt-get; then
    run_maybe_sudo apt-get update -y -qq
    run_maybe_sudo apt-get install -y -qq certbot python3-certbot-nginx
  elif command_exists dnf; then
    run_maybe_sudo dnf install -y -q certbot python3-certbot-nginx || run_maybe_sudo dnf install -y -q certbot-nginx
  else
    die "请手动安装 certbot"
  fi
}

setup_nginx_proxy_http() {
  local domain="$1" upstream_port="$2"
  local conf_dir conf_file
  conf_dir="$(nginx_conf_dir)"
  conf_file="${conf_dir}/${domain}.conf"

  run_maybe_sudo mkdir -p "$conf_dir"
  run_maybe_sudo_shell "cat > '${conf_file}' <<'NGINX_EOF'
server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${upstream_port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
NGINX_EOF"

  if [[ -d /etc/nginx/sites-enabled && "$conf_dir" == "/etc/nginx/sites-available" ]]; then
    run_maybe_sudo ln -sf "${conf_file}" "/etc/nginx/sites-enabled/${domain}.conf"
  fi
  run_maybe_sudo nginx -t
  run_maybe_sudo systemctl reload nginx 2>/dev/null || run_maybe_sudo nginx -s reload
}

prepare_runtime() {
  if discover_local_project_root; then
    :
  else
    clone_or_update_repo "$DEFAULT_INSTALL_DIR"
    if ! is_valid_project_root "$PROJECT_ROOT"; then
      if is_interactive; then
        warn "默认克隆目录不是完整项目：$PROJECT_ROOT"
        warn "你可以输入实际项目目录，或先修正仓库内容后再重新部署"
        prompt_for_project_root || die "未找到可部署的项目目录：$PROJECT_ROOT"
      else
        die "默认克隆目录不是完整项目：$PROJECT_ROOT（需要包含 docker-compose.yml 和 Dockerfile）"
      fi
    fi
  fi
  ensure_project_root
  detect_env_file
  detect_public_ports
  install_docker_if_needed
}

compose_up() {
  info "使用环境文件：$ENV_FILE"
  info "Web 端口：${WEB_PORT}   SMTP 端口：${SMTP_PORT}"
  (
    cd "$PROJECT_ROOT"
    run_cmd "${DOCKER_COMPOSE_CMD[@]}" up -d --build
  )
}

compose_ps() {
  (
    cd "$PROJECT_ROOT"
    run_cmd "${DOCKER_COMPOSE_CMD[@]}" ps
  )
}

compose_logs() {
  (
    cd "$PROJECT_ROOT"
    run_cmd "${DOCKER_COMPOSE_CMD[@]}" logs -f --tail 150 cloudmail
  )
}

compose_restart() {
  (
    cd "$PROJECT_ROOT"
    run_cmd "${DOCKER_COMPOSE_CMD[@]}" restart cloudmail
  )
}

compose_down() {
  (
    cd "$PROJECT_ROOT"
    run_cmd "${DOCKER_COMPOSE_CMD[@]}" down
  )
}

print_access_summary() {
  local server_ip
  server_ip="$(curl -s --connect-timeout 5 ifconfig.me 2>/dev/null || true)"
  [[ -z "$server_ip" ]] && server_ip="你的服务器IP"

  echo
  ok "CloudMail Server 已启动！（只接收模式友好）"
  echo
  echo "  Web UI + API :  http://${server_ip}:${WEB_PORT}"
  echo "  内置 SMTP 接收 :  ${server_ip}:${SMTP_PORT}   （MX 记录应指向本服务器 25 端口）"
  echo
  echo "重要提醒（只收不发）："
  echo "  1. 确保已修改 JWT_SECRET（至少32位随机）、ADMIN、DOMAIN"
  echo "  2. 域名 MX 记录 → 服务器公网 IP（优先级 10）"
  echo "  3. 阿里云安全组必须入方向开放：25（或 2525）、3000"
  echo "  4. 强烈建议配置对象存储（R2/OSS/B2）保存附件，节省磁盘和内存"
  echo "  5. 登录 Web UI 后 → 系统设置 → 开启「接收邮件」，可关闭发送功能"
  echo
  echo "推荐操作："
  echo "  - bash cloudmail.sh enable-ssl     # 一键申请 HTTPS（nginx + certbot）"
  echo "  - bash cloudmail.sh logs"
  echo
}

deploy() {
  prepare_runtime

  # 如果用户还没改关键配置，给一次交互机会
  if env_has_placeholder_values; then
    warn "检测到默认配置，建议现在配置关键参数"
    if ! is_interactive; then
      if (( DRY_RUN )); then
        warn "当前为非交互 dry-run，跳过 .env 默认值填写"
      else
        die "非交互模式检测到默认配置，请先手动修改 ${ENV_FILE} 后再执行 deploy"
      fi
    else
      local jwt admin domains receive_only=""
      jwt="$(prompt_default "JWT_SECRET（强烈建议修改）" "$(read_env_value JWT_SECRET)")"
      admin="$(prompt_default "ADMIN 管理员邮箱" "$(read_env_value ADMIN)")"
      domains="$(prompt_default "DOMAIN（JSON 数组，如 [\"example.com\"]）" "$(read_env_value DOMAIN)")"

      if ask_yes_no "是否只接收邮件、不发送（推荐用于纯收件场景）" "y"; then
        receive_only=1
        warn "已选择只收模式：发送相关配置可留空或稍后在 Web UI 关闭"
      fi

      [[ -n "$jwt" ]] && set_env_value "JWT_SECRET" "$jwt"
      [[ -n "$admin" ]] && set_env_value "ADMIN" "$admin"
      [[ -n "$domains" ]] && set_env_value "DOMAIN" "$domains"

      # 为只收模式添加注释
      if [[ -n "$receive_only" ]]; then
        echo "" >> "$ENV_FILE"
        echo "# 只接收模式（不发邮件）" >> "$ENV_FILE"
        echo "# SMTP_ENABLED=true 已启用内置接收" >> "$ENV_FILE"
        echo "# 建议在 Web UI 系统设置中关闭发送相关功能" >> "$ENV_FILE"
      fi
    fi
  fi

  compose_up
  allow_firewall_port "$WEB_PORT"
  allow_firewall_port "$SMTP_PORT"
  save_state
  print_access_summary
}

status_app() {
  require_state
  detect_public_ports
  pick_compose_cmd
  info "当前部署：$APP_NAME"
  info "项目目录：$PROJECT_ROOT"
  info "Web 端口：${WEB_PORT}   SMTP 端口：${SMTP_PORT}"
  compose_ps
}

logs_app() {
  require_state
  pick_compose_cmd
  info "查看容器日志（cloudmail）"
  compose_logs
}

restart_app() {
  require_state
  pick_compose_cmd
  compose_restart
  save_state
  ok "服务已重启"
}

update_app() {
  require_state
  if [[ "${PROJECT_SOURCE:-local}" == "git" ]]; then
    info "拉取最新代码..."
    (
      cd "$PROJECT_ROOT"
      run_cmd git pull --ff-only
    )
  fi
  detect_public_ports
  pick_compose_cmd
  compose_up
  allow_firewall_port "$WEB_PORT"
  allow_firewall_port "$SMTP_PORT"
  save_state
  ok "更新完成"
}

enable_ssl() {
  local domain
  require_state
  detect_public_ports
  install_nginx_if_needed
  install_certbot_if_needed

  domain="$(prompt_default "请输入要绑定的域名（例如 mail.example.com）" "")"
  [[ -n "$domain" ]] || die "域名不能为空"

  setup_nginx_proxy_http "$domain" "$WEB_PORT"
  allow_firewall_port 80
  allow_firewall_port 443

  local email
  email="$(prompt_default "ACME 邮箱（用于证书通知）" "admin@${domain}")"

  run_maybe_sudo certbot --nginx -d "$domain" --redirect -m "$email" --agree-tos --non-interactive

  ok "HTTPS 已启用"
  echo "访问地址：https://${domain}"
  echo "注意：SMTP 接收仍然使用 25/2525 端口（不走 nginx）"
}

uninstall_app() {
  require_state
  pick_compose_cmd
  warn "将停止并删除容器（数据卷 cloudmail-data 保留）"
  if [[ ! -t 0 ]] || ask_yes_no "确认卸载" "n"; then
    compose_down
    if (( DRY_RUN )); then
      info "[dry-run] 删除状态文件"
    else
      rm -f "$STATE_FILE"
    fi
    ok "卸载完成（项目代码和数据卷保留）"
  fi
}

print_menu() {
  echo
  echo "========= CloudMail Server 一键运维脚本 ========="
  echo "1) 一键部署 / 启动"
  echo "2) 查看状态"
  echo "3) 查看日志"
  echo "4) 重启服务"
  echo "5) 更新应用"
  echo "6) 启用 HTTPS（nginx + certbot）"
  echo "7) 修复项目目录"
  echo "8) 卸载"
  echo "0) 退出"
  echo "================================================="
}

menu_loop() {
  local choice
  while true; do
    print_menu
    printf '请选择 [0-8]: ' >&2
    read -r choice
    choice="$(trim "$choice")"
    case "$choice" in
      1) deploy ;;
      2) status_app ;;
      3) logs_app ;;
      4) restart_app ;;
      5) update_app ;;
      6) enable_ssl ;;
      7) repair_project_root ;;
      8) uninstall_app ;;
      0) exit 0 ;;
      *) warn "无效选项" ;;
    esac
  done
}

main() {
  case "${ACTION:-}" in
    deploy) deploy ;;
    status) status_app ;;
    logs) logs_app ;;
    restart) restart_app ;;
    update) update_app ;;
    enable-ssl) enable_ssl ;;
    repair-project) repair_project_root ;;
    uninstall) uninstall_app ;;
    menu) menu_loop ;;
    "")
      if is_interactive; then
        menu_loop
      else
        deploy
      fi
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
