#!/usr/bin/env bash
set -Eeuo pipefail

# 用法: cert.sh <域名> [--skip-dns-check]
# 结果: /home/nginx/cert/<域名>/{full_chain.pem,private.key}
#       并自动写入 /home/nginx/conf.d/<域名>.conf、启动并重载 nginx

NGINX_DIR="${NGINX_DIR:-/home/nginx}"
CONF_DIR="$NGINX_DIR/conf.d"
HTML_DIR="$NGINX_DIR/html"
CERT_ROOT="$NGINX_DIR/cert"
ACME_HOME="${ACME_HOME:-/root/.acme.sh}"
ACME_EMAIL="${ACME_EMAIL:-admin@sh99y.com}"
CA_SERVER="${CA_SERVER:-letsencrypt}"
KEY_LENGTH="${KEY_LENGTH:-2048}"
CONTAINER="${NGINX_CONTAINER:-nginx}"
HTML_MOUNT="/usr/share/nginx/html"

log() { printf '[cert] %s\n' "$*"; }
die() { printf '错误: %s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'EOF'
用法: cert.sh <域名> [--skip-dns-check]

示例:
  cert.sh mall.sh99y.com

可选环境变量:
  ACME_EMAIL   CA 账户邮箱 (默认 admin@sh99y.com)
  KEY_LENGTH   密钥长度 (默认 2048, RSA)
  CA_SERVER    CA 服务 (默认 letsencrypt)

结果:
  /home/nginx/cert/<域名>/full_chain.pem
  /home/nginx/cert/<域名>/private.key
  并自动写入 /home/nginx/conf.d/<域名>.conf、启动并重载 nginx
EOF
  exit 1
}

DOMAIN=""
SKIP_DNS_CHECK=0
for arg in "$@"; do
  case "$arg" in
    --skip-dns-check) SKIP_DNS_CHECK=1 ;;
    -h|--help) usage ;;
    -*) die "未知参数: $arg" ;;
    *)
      [ -z "$DOMAIN" ] || die "只能指定一个域名"
      DOMAIN="$arg"
      ;;
  esac
done
[ -n "$DOMAIN" ] || usage
DOMAIN="${DOMAIN,,}"

[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]] \
  || die "域名格式不合法: $DOMAIN"

[ "$(id -u)" -eq 0 ] || die "请使用 root 运行"
command -v docker >/dev/null 2>&1 || die "未安装 docker"
docker compose version >/dev/null 2>&1 || die "未安装 docker compose"
[ -f "$NGINX_DIR/docker-compose.yml" ] || die "找不到 $NGINX_DIR/docker-compose.yml"
command -v curl >/dev/null 2>&1 || die "未安装 curl"

CERT_DIR="$CERT_ROOT/$DOMAIN"
CONF_FILE="$CONF_DIR/$DOMAIN.conf"
mkdir -p "$CONF_DIR" "$HTML_DIR" "$CERT_DIR"

compose() { ( cd "$NGINX_DIR" && docker compose "$@" ); }
ngx() { compose exec -T "$CONTAINER" nginx "$@"; }

# ---------- 1. DNS 预检查 ----------
if command -v dig >/dev/null 2>&1; then
  IPS="$(dig +short A "$DOMAIN" @1.1.1.1 2>/dev/null | grep -E '^[0-9.]+$' | sort -u || true)"
else
  IPS="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u || true)"
fi
[ -n "$IPS" ] || die "域名 $DOMAIN 没有 A 记录, 请先完成 DNS 解析"
log "DNS A 记录: $(printf '%s' "$IPS" | tr '\n' ' ')"
if [ "$SKIP_DNS_CHECK" -eq 0 ]; then
  PUBIP="$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
  if [ -n "$PUBIP" ] && ! printf '%s\n' "$IPS" | grep -qx "$PUBIP"; then
    log "警告: 域名解析到 $(printf '%s' "$IPS" | tr '\n' ' '), 本机公网 IP 为 $PUBIP; 若域名走 CDN 可忽略"
  fi
fi

# ---------- 2. 安装 acme.sh (不安装续期 cron) ----------
if [ ! -x "$ACME_HOME/acme.sh" ]; then
  log "安装 acme.sh ..."
  curl -fsSL https://get.acme.sh | sh -s email="$ACME_EMAIL" --nocron
fi
[ -x "$ACME_HOME/acme.sh" ] || die "acme.sh 安装失败"

# ---------- 3. 端口占用检查 ----------
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  if ss -lnt 2>/dev/null | grep -Eq ':(80|443)[[:space:]]'; then
    echo "当前 80/443 监听:" >&2
    ss -lntp 2>/dev/null | grep -E ':(80|443)[[:space:]]' >&2 || true
    die "80/443 已被其他服务占用, 请先释放端口"
  fi
fi

# ---------- 4. nginx 配置生成 ----------
write_challenge_conf() {
  cat > "$CONF_FILE" <<EOF
# 由 cert.sh 生成: $DOMAIN 证书申请阶段配置
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location ^~ /.well-known/acme-challenge/ {
        root $HTML_MOUNT;
        default_type text/plain;
        access_log off;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF
}

write_full_conf() {
  cat > "$CONF_FILE" <<EOF
# 由 cert.sh 生成: $DOMAIN 正式配置
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location ^~ /.well-known/acme-challenge/ {
        root $HTML_MOUNT;
        default_type text/plain;
        access_log off;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name $DOMAIN;

    ssl_certificate     /etc/nginx/cert/$DOMAIN/full_chain.pem;
    ssl_certificate_key /etc/nginx/cert/$DOMAIN/private.key;

    ssl_protocols             TLSv1.2 TLSv1.3;
    ssl_ciphers               HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers off;
    ssl_session_cache         shared:SSL:10m;
    ssl_session_timeout       1d;
    ssl_session_tickets       off;

    root $HTML_MOUNT;
    index index.html index.htm;
    charset utf-8;
    server_tokens off;

    location / {
        try_files \$uri \$uri/ =404;
    }

    error_page 404 /404.html;
    location = /404.html {
        internal;
    }
}
EOF
}

apply_config() {
  local writer="$1" backup=""
  if [ -f "$CONF_FILE" ]; then
    backup="$(mktemp)"
    cp -f "$CONF_FILE" "$backup"
  fi
  "$writer"
  if ! ngx -t >/tmp/cert-nginx-test.log 2>&1; then
    if [ -n "$backup" ]; then cp -f "$backup" "$CONF_FILE"; else rm -f "$CONF_FILE"; fi
    cat /tmp/cert-nginx-test.log >&2
    die "nginx 配置校验失败, 已回滚"
  fi
  [ -n "$backup" ] && rm -f "$backup"
  ngx -s reload >/dev/null
  log "nginx 已重新加载"
}

# ---------- 5. 启动 nginx ----------
if [ ! -s "$CERT_DIR/full_chain.pem" ] || [ ! -s "$CERT_DIR/private.key" ]; then
  log "写入证书申请阶段的 nginx 配置"
  write_challenge_conf
fi

log "启动 nginx ..."
compose up -d
for _ in $(seq 1 30); do
  compose exec -T "$CONTAINER" true >/dev/null 2>&1 && break
  sleep 1
done
if ! compose exec -T "$CONTAINER" true >/dev/null 2>&1; then
  compose logs --tail=60 "$CONTAINER" >&2 || true
  die "nginx 容器启动失败"
fi
ngx -t >/dev/null || die "nginx 配置校验失败"
ngx -s reload >/dev/null 2>&1 || true

# ---------- 6. 申请证书 ----------
log "向 $CA_SERVER 申请证书: $DOMAIN"
if ! "$ACME_HOME/acme.sh" --issue \
      --server "$CA_SERVER" \
      --keylength "$KEY_LENGTH" \
      -d "$DOMAIN" \
      -w "$HTML_DIR" \
      --log; then
  echo "--- acme.sh 日志 (尾部) ---" >&2
  tail -n 50 "$ACME_HOME/acme.sh.log" >&2 || true
  die "证书申请失败"
fi

# ---------- 7. 安装证书 ----------
log "安装证书到 $CERT_DIR"
"$ACME_HOME/acme.sh" --install-cert -d "$DOMAIN" \
  --key-file "$CERT_DIR/private.key" \
  --fullchain-file "$CERT_DIR/full_chain.pem" \
  --reloadcmd "docker exec $CONTAINER nginx -s reload"
chmod 600 "$CERT_DIR/private.key"
chmod 644 "$CERT_DIR/full_chain.pem"

# ---------- 8. 写入正式配置并验证 ----------
apply_config write_full_conf

log "验证 HTTPS ..."
sleep 1
CODE="$(curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' \
  --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" 2>/dev/null || true)"
case "$CODE" in
  200|301|302|404) log "本地 HTTPS 握手成功 (HTTP $CODE)" ;;
  *) log "警告: 本地 HTTPS 验证返回 '${CODE:-无响应}'" ;;
esac
openssl x509 -in "$CERT_DIR/full_chain.pem" -noout \
  -subject -issuer -dates -ext subjectAltName 2>/dev/null | sed 's/^/  /'

echo
log "完成。证书文件:"
echo "  $CERT_DIR/full_chain.pem"
echo "  $CERT_DIR/private.key"