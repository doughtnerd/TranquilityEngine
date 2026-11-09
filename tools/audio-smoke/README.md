# Audio core webview smoke (ADR 0157, A0.7)

Checks that the audio core's dev tone (`src/plugins/audio/runtime/worklet/devTone.html`, a 440 Hz sine at amplitude 0.1, so an RMS of 0.0707) plays in the webviews Tauri 2 uses, and what autoplay policy each applies. Nothing here ships.

## WebKitGTK (Linux, Docker)

```
tools/audio-smoke/run-webkitgtk.sh                      # PORT=3107 by default
AUTOPLAY_POLICY=allow tools/audio-smoke/run-webkitgtk.sh  # also: allow-without-sound, deny
```

Needs Docker with the Linux engine. The script builds `Dockerfile` (ubuntu:24.04, `libwebkit2gtk-4.1`, GStreamer, Xvfb, PulseAudio), starts `vite` on the host, and runs the container. Inside, a PulseAudio null sink is the default output, `viewer.py` (a WebKit2 WebView) opens the dev page through a `socat` forward as `http://localhost:PORT` (a secure context, which AudioWorklet needs; `host.docker.internal` is not one), and the sink's monitor is recorded with `parecord` twice: with no gesture, then after an `xdotool` click. `analyze.py` reports the RMS and the strongest frequency. Recordings and logs land in `out/` (git-ignored).

## WebView2 (Windows)

`wv2.conf.json` overrides the Tauri config so the dev shell opens the tone page in one window:

```
npx vite --port 3107 --strictPort                        # terminal 1
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 npx tauri dev --config tools/audio-smoke/wv2.conf.json
node tools/audio-smoke/cdp-eval.mjs "document.getElementById('out').textContent"   # page state through the debug port
powershell tools/audio-smoke/loopback.ps1 -Out out/wv2.wav -Seconds 4              # WASAPI loopback of the default output
python -I tools/audio-smoke/analyze.py out/wv2.wav
```

`loopback.ps1` is our own Core Audio COM capture (no installs); the tone is audible on the default output while it records. `cdp-eval.mjs` clicks `#tone` to switch the tone off for a silent control recording.

## Two Worlds, one host

`PORT=3107 node tools/audio-smoke/twoEngines.mjs` (dev server running) starts the real `myco.audio` service in two stand-in Worlds in Chromium and prints whether they share one host and one `AudioContext`.
