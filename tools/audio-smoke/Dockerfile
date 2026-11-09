# WebKitGTK (the webview Tauri 2 uses on Linux) with a virtual display and a PulseAudio null sink, so the audio
# core's tone can be recorded without a sound card. ADR 0157 MS1 gate (A0.7).
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-0 gir1.2-webkit2-4.1 python3 python3-gi python3-numpy gir1.2-gtk-3.0 \
      gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-pulseaudio gstreamer1.0-libav \
      xvfb xdotool pulseaudio pulseaudio-utils socat ca-certificates dbus-x11 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /smoke
COPY viewer.py analyze.py container-run.sh /smoke/
RUN chmod +x /smoke/container-run.sh
USER ubuntu
ENTRYPOINT ["/smoke/container-run.sh"]
