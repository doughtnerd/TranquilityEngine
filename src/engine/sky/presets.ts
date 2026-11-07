/**
 * Built-in sky presets (ADR 0112): starting points for New Sky and the sample assets in
 * `samples/playground3d/skies/`. Each is a complete `SkySettings`.
 */
import { defaultCloudLayer, defaultSky, type SkySettings } from "./skyFormat";

export type SkyPresetId = "clearDay" | "sunset" | "overcast" | "night" | "gradient";

export const SKY_PRESETS: readonly { id: SkyPresetId; label: string; file: string }[] = [
  { id: "clearDay", label: "Clear Day", file: "clear-day" },
  { id: "sunset", label: "Sunset", file: "sunset" },
  { id: "overcast", label: "Overcast", file: "overcast" },
  { id: "night", label: "Night", file: "night" },
  { id: "gradient", label: "Simple Gradient", file: "gradient" },
];

export function skyPreset(id: SkyPresetId): SkySettings {
  const sky = defaultSky();
  switch (id) {
    case "clearDay":
      sky.sun.timeOfDay = 11;
      sky.clouds = [{ ...defaultCloudLayer(), coverage: 0.3, density: 0.5, scale: 1.2 }];
      break;
    case "sunset":
      sky.sun.timeOfDay = 20.2;
      sky.atmosphere.mie = 2.5;
      sky.sunDisc.size = 1.2;
      sky.sunDisc.glow = 0.7;
      sky.clouds = [{ ...defaultCloudLayer(), coverage: 0.35, density: 0.45, scale: 1.5, color: "#ffe2c8", direction: 100, speed: 0.5 }];
      sky.horizon.fogBlend = 0.2;
      sky.horizon.color = "#f0b48c";
      sky.exposure = 0.5;
      break;
    case "overcast":
      sky.sun.timeOfDay = 13;
      sky.atmosphere.mie = 8;
      sky.sunDisc.enabled = false;
      sky.clouds = [
        { ...defaultCloudLayer(), coverage: 0.9, density: 0.9, scale: 0.8, color: "#c8ccd2", speed: 1.5 },
        { ...defaultCloudLayer(), coverage: 0.7, density: 0.6, scale: 2, color: "#e0e3e8", speed: 0.6, direction: 80, altitude: 5 },
      ];
      sky.horizon.fogBlend = 0.5;
      sky.horizon.height = 20;
      sky.lighting.sunIntensity = 3;
      break;
    case "night":
      sky.sun.timeOfDay = 23.5;
      sky.moon.phase = 0.45;
      sky.moon.glow = 0.5;
      sky.stars.density = 0.7;
      sky.stars.brightness = 1.5;
      sky.clouds = [{ ...defaultCloudLayer(), coverage: 0.2, density: 0.4, color: "#9aa4b8", speed: 0.4 }];
      sky.exposure = 2;
      sky.lighting.moonIntensity = 0.25;
      break;
    case "gradient":
      sky.mode = "gradient";
      sky.sun.timeOfDay = 15;
      sky.clouds = [];
      sky.stars.enabled = false;
      break;
  }
  return sky;
}
