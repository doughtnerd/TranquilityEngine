#!/bin/bash
# One-command WebKitGTK smoke: builds the image, starts the Vite dev server on the host (PORT, default 3107),
# runs the container, and writes recordings plus logs to tools/audio-smoke/out/. Needs Docker with the Linux engine.
set -eu
cd "$(dirname "$0")"
PORT="${PORT:-3107}"
docker build -t myco-audio-smoke .
(cd ../.. && npx vite --port "$PORT" --host 0.0.0.0 --strictPort > tools/audio-smoke/out-vite.log 2>&1) & VITE=$!
trap 'kill $VITE 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -sf -o /dev/null "http://localhost:$PORT/" && break; sleep 1; done
rm -rf out; mkdir -p out
MSYS_NO_PATHCONV=1 docker run --rm -e AUTOPLAY_POLICY="${AUTOPLAY_POLICY:-}" -v "$(pwd -W 2>/dev/null || pwd)/out:/out" myco-audio-smoke "host.docker.internal:$PORT"
