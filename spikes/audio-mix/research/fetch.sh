#!/bin/sh
# Re-fetches every primary source this survey cites into ./sources (untracked scratch). Fetched 2026-11-12, default branches.
set -e; mkdir -p sources; cd sources; R=https://raw.githubusercontent.com
g(){ curl -sS -m 40 -o "$1" -w "$1 %{http_code}\n" "$2"; }
g libebur128.c $R/jiixyj/libebur128/master/ebur128/ebur128.c
g libebur128_COPYING $R/jiixyj/libebur128/master/COPYING
g ebur128_Cargo.toml $R/sdroege/ebur128/main/Cargo.toml
for f in lib ebur128 filter true_peak interp history; do g ebur128_$f.rs $R/sdroege/ebur128/main/src/$f.rs; done
g crates_index_ebur128.jsonl https://index.crates.io/eb/ur/ebur128
g unity_AudioMixerWindow.cs $R/Unity-Technologies/UnityCsReference/master/Editor/Mono/Audio/Mixer/GUI/AudioMixerWindow.cs
g unity_ChannelStripView.cs $R/Unity-Technologies/UnityCsReference/master/Editor/Mono/Audio/Mixer/GUI/AudioMixerChannelStripView.cs
g godot_audio_server.cpp $R/godotengine/godot/master/servers/audio/audio_server.cpp
g godot_compressor.cpp $R/godotengine/godot/master/servers/audio/effects/audio_effect_compressor.cpp
G=$R/geode-sdk/geode/main/loader/include/Geode/fmod   # FMOD Core 2.x headers vendored by the Geode SDK
for f in fmod.h fmod_common.h fmod_dsp.h fmod_dsp_effects.h; do g geode_$f $G/$f; done
