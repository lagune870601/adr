#!/usr/bin/env bash
set -Eeuo pipefail

# 用法: ./install-docker.sh [--test]
# 适用: Debian / Ubuntu (amd64, arm64)
# 说明: 幂等，可重复执行。安装 Docker CE + compose + buildx，并设置开机自启。
#       会自动备份软件源，并在遇到失效的可选源/已 EOL 的安全源时禁用后重试。
#       --test  安装后拉取 hello-world 做运行验证

log() { printf '[docker-install] %s\n' "$*"; }
die() { printf '错误: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行（或 sudo bash $0）"
command -v systemctl >/dev/null 2>&1 || die "未检测到 systemd，本脚本仅适用于常规 Debian/Ubuntu 主机"

RUN_TEST=0
[ "${1:-}" = "--test" ] && RUN_TEST=1

[ -r /etc/os-release ] || die "无法读取 /etc/os-release"
# shellcheck disable=SC1091
. /etc/os-release

case "${ID:-}" in
  debian|ubuntu) ;;
  *) die "仅支持 Debian/Ubuntu，当前系统: ${ID:-unknown}" ;;
esac

CODENAME="${VERSION_CODENAME:-}"
[ -n "$CODENAME" ] || die "无法获取发行版代号 (VERSION_CODENAME)"

is_eol_debian() {
  local major="${VERSION_ID%%.*}"
  [ "$ID" = "debian" ] && [[ "$major" =~ ^[0-9]+$ ]] && [ "$major" -le 11 ]
}

export DEBIAN_FRONTEND=noninteractive

if [ -f /etc/apt/sources.list ] && [ ! -f /etc/apt/sources.list.bak ]; then
  cp -a /etc/apt/sources.list /etc/apt/sources.list.bak
  log "已备份软件源到 /etc/apt/sources.list.bak"
fi

apt_update() { apt-get update -y; }

if ! apt_update; then
  log "apt-get update 失败，尝试禁用可选/已失效的软件源后重试"
  if [ -f /etc/apt/sources.list ]; then
    # backports 为可选仓库，镜像未同步时会导致 update 失败
    sed -i -E 's|^[[:space:]]*deb(-src)? .*-backports.*|# &|' /etc/apt/sources.list
    # Debian 11 及更早版本已 EOL，security.debian.org 不再提供包
    if is_eol_debian; then
      sed -i -E 's|^[[:space:]]*deb(-src)? .*security\.debian\.org.*|# &|' /etc/apt/sources.list
      log "检测到 Debian ${VERSION_ID}（已 EOL），已禁用失效的安全源"
    fi
  fi
  apt_update || die "apt-get update 仍失败，请手动检查 /etc/apt/sources.list"
fi

log "安装基础依赖"
apt-get install -y --no-upgrade ca-certificates curl || die "基础依赖安装失败"

log "添加 Docker 官方 GPG key"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc \
  || die "下载 Docker GPG key 失败"
chmod a+r /etc/apt/keyrings/docker.asc

log "写入 Docker apt 源"
ARCH="$(dpkg --print-architecture)"
echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list

log "更新 apt 索引（含 Docker 源）"
apt_update || die "apt-get update 失败（Docker 源）"

log "安装 Docker CE / Compose / Buildx"
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
  || die "Docker 安装失败"

log "设置开机自启并启动 Docker"
systemctl enable --now docker || die "启动 Docker 服务失败"

log "版本信息"
docker --version
docker compose version
docker info --format 'Server: {{.ServerVersion}} | Storage: {{.Driver}} | Cgroup: {{.CgroupVersion}}'

systemctl is-enabled docker >/dev/null || die "docker 未设置为开机自启"
systemctl is-active docker >/dev/null || die "docker 服务未运行"

if [ "$RUN_TEST" -eq 1 ]; then
  log "运行 hello-world 验证"
  docker run --rm hello-world >/dev/null && log "hello-world 验证成功"
fi

log "Docker 已安装并运行。常用命令: docker ps / docker compose up -d"