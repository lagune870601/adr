#!/bin/bash
set -e

MITM_PORT="${MITM_PORT:-18008}"
BOOTSTRAP_PORT="${BOOTSTRAP_PORT:-18080}"
mkdir -p /app/logs

# 引导请求的本地落地点：SOCKS5 握手需要目标可达，这里用本地 dummy HTTP 服务，
# 避免依赖外部 httpbin.org（容器 /etc/hosts 把引导域名指向 127.0.0.1）
node -e "require('http').createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end('<!DOCTYPE html><html><head><title>Empty Page</title></head><body></body></html>')}).listen(${BOOTSTRAP_PORT},'127.0.0.1')" \
  > /app/logs/bootstrap.log 2>&1 &
DUMMY_PID=$!

export PYTHONUNBUFFERED=1
mitmdump -q -s /app/botAnti3.py --mode socks5 \
  --listen-port "$MITM_PORT" --set block_global=false \
  > /app/logs/mitmdump.log 2>&1 &
MITM_PID=$!

cleanup() {
  kill "$MITM_PID" "$DUMMY_PID" 2>/dev/null || true
  wait "$MITM_PID" "$DUMMY_PID" 2>/dev/null || true
}
trap cleanup INT TERM

# 等 mitmdump 监听端口（镜像里没有 nc，用 node 探测）
for _ in $(seq 1 50); do
  if node -e "const n=require('net');const s=n.connect(${MITM_PORT},'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"; then
    break
  fi
  sleep 0.2
done

export SOCKS_PROXY="${SOCKS_PROXY:-socks5://127.0.0.1:${MITM_PORT}}"

set +e
node /app/mybid.js "$@"
STATUS=$?
set -e

cleanup
exit "$STATUS"