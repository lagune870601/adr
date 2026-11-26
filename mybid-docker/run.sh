#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="${IMAGE:-visit-page-md:latest}"
NAME="${NAME:-visit-page-md}"

docker rm -f "$NAME" >/dev/null 2>&1 || true

docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  --env-file ./mybid.env \
  --add-host bootstrap.mitm.local:127.0.0.1 \
  "$IMAGE"

echo "started $NAME ($IMAGE); follow logs with: docker logs -f $NAME"