#!/bin/bash
# Runs inside the container. $1 = dev-server host:port to forward as localhost:PORT (a secure context for AudioWorklet).
set -u
HOSTPORT="${1:?host:port}"; PORT="${HOSTPORT##*:}"; PAGE="${2:-/src/plugins/audio/runtime/worklet/devTone.html}"
export XDG_RUNTIME_DIR=/tmp/xdg; mkdir -p $XDG_RUNTIME_DIR; chmod 700 $XDG_RUNTIME_DIR
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 LIBGL_ALWAYS_SOFTWARE=1
pulseaudio -D --exit-idle-time=-1 --log-target=stderr || { echo "pulseaudio failed"; exit 1; }; sleep 1
pactl load-module module-null-sink sink_name=smoke sink_properties=device.description=smoke >/dev/null
pactl set-default-sink smoke
Xvfb :99 -screen 0 1024x768x24 >/dev/null 2>&1 & export DISPLAY=:99; sleep 1
socat TCP-LISTEN:$PORT,fork,reuseaddr TCP:$HOSTPORT & sleep 0.5
dpkg -s libwebkit2gtk-4.1-0 | grep '^Version'
mkdir -p /out
python3 /smoke/viewer.py "http://localhost:$PORT$PAGE" > /out/viewer.log 2>&1 &
sleep 12
echo "== phase 1: no gesture"
parecord -d smoke.monitor --file-format=wav --rate=48000 --channels=1 /out/no-click.wav & R=$!; sleep 4; kill -INT $R; wait $R 2>/dev/null
tail -n 2 /out/viewer.log | cut -c1-400
echo "== phase 2: click"
xdotool mousemove 400 300 click 1; sleep 3
parecord -d smoke.monitor --file-format=wav --rate=48000 --channels=1 /out/after-click.wav & R=$!; sleep 4; kill -INT $R; wait $R 2>/dev/null
tail -n 2 /out/viewer.log | cut -c1-400
python3 /smoke/analyze.py /out/no-click.wav; python3 /smoke/analyze.py /out/after-click.wav
grep -m1 WEBKITGTK_VERSION /out/viewer.log; grep -m1 media-playback /out/viewer.log
grep -m1 '^PAGE' /out/viewer.log | cut -c1-300
