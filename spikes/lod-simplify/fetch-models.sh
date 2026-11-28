#!/bin/sh
# Downloads the third-party test models (NOT committed) into $LOD_MODELS (default /tmp/claude-0/lod-models).
set -e
D="${LOD_MODELS:-/tmp/claude-0/lod-models}"
B=https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models
mkdir -p "$D"
for m in DamagedHelmet Lantern Avocado CesiumMan Fox; do
  [ -s "$D/$m.glb" ] || curl -sfL -o "$D/$m.glb" "$B/$m/glTF-Binary/$m.glb"
done
for m in FlightHelmet Sponza; do
  [ -s "$D/$m.gltf" ] || curl -sfL -o "$D/$m.gltf" "$B/$m/glTF/$m.gltf"
  [ -s "$D/$m.bin" ] || curl -sfL -o "$D/$m.bin" "$B/$m/glTF/$m.bin"
done
ls -l "$D"
