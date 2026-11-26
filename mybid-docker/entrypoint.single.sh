#!/bin/bash
set -euo pipefail

MITM_PORT="${MITM_PORT:-18008}"
BOOTSTRAP_PORT="${BOOTSTRAP_PORT:-18080}"
ALLOCATOR_PORT="${ALLOCATOR_PORT:-18010}"

if ! grep -q "bootstrap.mitm.local" /etc/hosts 2>/dev/null; then
  echo "127.0.0.1 bootstrap.mitm.local" >> /etc/hosts 2>/dev/null || true
fi

PIDS=()

start() {
  local name="$1"
  shift
  setsid bash /app/prefix.sh "$name" "$@" &
  PIDS+=("$!")
}

cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] || continue
    kill -TERM -- "-$pid" 2>/dev/null || true
  done
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] || continue
    wait "$pid" 2>/dev/null || true
  done
}

trap 'echo "[init] received stop signal"; cleanup; exit 0' INT TERM

start boot node -e "require('http').createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end('<!DOCTYPE html><html><head><title>Empty Page</title></head><body></body></html>')}).listen(${BOOTSTRAP_PORT},'127.0.0.1')"

start alloc node /app/ip-allocator/index.js

echo "[init] waiting for ip-allocator health on 127.0.0.1:${ALLOCATOR_PORT}"
for i in $(seq 1 240); do
  if node -e "fetch('http://127.0.0.1:${ALLOCATOR_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo "[init] ip-allocator ready"
    break
  fi
  if [ "$i" -eq 240 ]; then
    echo "[init] ip-allocator not healthy after 120s, starting bot anyway" >&2
  fi
  sleep 0.5
done

mkdir -p /app/logs
export PYTHONUNBUFFERED=1
setsid mitmdump -q -s /app/botAnti3.py --mode socks5 \
  --listen-port "$MITM_PORT" --set block_global=false \
  > /app/logs/mitmdump.log 2>&1 &
PIDS+=("$!")

for i in $(seq 1 100); do
  if node -e "const n=require('net');const s=n.connect(${MITM_PORT},'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"; then
    echo "[init] mitmproxy socks5 ready"
    break
  fi
  sleep 0.2
done

export SOCKS_PROXY="${SOCKS_PROXY:-socks5://127.0.0.1:${MITM_PORT}}"

start bot node /app/mybid.js

set +e
wait -n "${PIDS[@]}"
CODE=$?
set -e

echo "[init] a child process exited (code ${CODE}), shutting down container"
cleanup
exit "$CODE"