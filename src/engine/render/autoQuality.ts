/**
 * Automatic graphics quality (ADR 0055, 0322): the one module that decides the tier when the project asks for
 * detection. It reads the device, decides whether to detect (from the player's saved choice, the tier detected
 * earlier and the platform's default), makes the first pick, takes each frame's time step, steps the tier down while
 * frames are slow, and saves the detected tier under its own Storage key. `Graphics` keeps the active tier; the guess
 * and the frame monitor are the pure rules in `qualityDetect.ts`.
 */
import type { GraphicsSettings } from "../core/graphics";
import { Storage } from "../platform/Storage";
import { Graphics } from "./Graphics";
import { FrameMonitor, guessTier, tierForGuess, type DeviceInfo } from "./qualityDetect";

/** The Storage key (namespace "settings") holding the tier automatic detection chose (ADR 0055). */
export const AUTO_QUALITY_KEY = "graphics.autoQuality";

/** Frames skipped before the monitor sees any, so start-up and the first load are past. */
const WARM_UP_FRAMES = 30;

let device: DeviceInfo | null = null;

/** What the browser says about the machine: the GPU's name, cores, memory and screen. Read once. */
function readDevice(): DeviceInfo {
  if (device) return device;
  const info: DeviceInfo = {};
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  if (nav?.hardwareConcurrency) info.cores = nav.hardwareConcurrency;
  if (typeof nav?.deviceMemory === "number") info.memoryGB = nav.deviceMemory;
  if (typeof screen !== "undefined") info.screenPixels = screen.width * screen.height * (globalThis.devicePixelRatio || 1) ** 2;
  try {
    const gl = typeof document !== "undefined" ? document.createElement("canvas").getContext("webgl2") : null;
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      info.gpu = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    // No GPU name: the guess falls back to the default tier.
  }
  return (device = info);
}

/**
 * The tier this machine suggests among the active project's tiers. A guess that says "the default" means the default
 * for this platform (`Graphics.defaultQuality`: `platformDefaults`, else `defaultTier`).
 */
export function detectedTier(): string {
  return tierForGuess(guessTier(readDevice()).guess, Graphics.tiers, Graphics.defaultQuality);
}

/** Automatic quality while it watches the first seconds of play. */
export interface AutoQuality {
  /** Hand it one frame's time step in seconds; false once it has stopped watching (drop it then). */
  frame(dt: number): boolean;
}

/**
 * Start automatic quality for a runtime that draws, once `Graphics` is configured with `settings` and the player's
 * saved tier (`saved`). It detects when the project's `autoDetect` is on and the player has no choice that names one
 * of the project's tiers (a renamed or removed tier is no choice). If configuring already restored a tier detected
 * earlier, that tier stays; otherwise the machine's guess is applied and saved. Returns null when the tier isn't
 * automatic.
 */
export function startAutoQuality(settings: GraphicsSettings, saved: unknown): AutoQuality | null {
  if (!settings.autoDetect) return null;
  if (typeof saved === "string" && settings.tiers.some((t) => t.name === saved)) return null;
  if (!Graphics.autoDetected) applyDetected(detectedTier());
  return new Watch(settings.targetFrameRate);
}

function applyDetected(name: string): void {
  if (!Graphics._applyDetected(name)) return;
  void Storage.save(AUTO_QUALITY_KEY, name, "settings").catch(() => undefined);
}

function atLowest(): boolean {
  return Graphics.tiers.indexOf(Graphics.quality) <= 0;
}

class Watch implements AutoQuality {
  private readonly monitor: FrameMonitor;
  private frames = 0;
  private stopped = false;

  constructor(targetFps: number) {
    this.monitor = new FrameMonitor({ targetFps });
    this.monitor.setAtLowest(atLowest());
  }

  frame(dt: number): boolean {
    if (this.stopped) return false;
    if (++this.frames < WARM_UP_FRAMES) return true;
    if (!Graphics.autoDetected) return this.stop(); // the player chose a tier meanwhile
    const verdict = this.monitor.frame(dt);
    if (verdict === "done") return this.stop();
    if (verdict === "stepDown") {
      const tiers = Graphics.tiers;
      const i = tiers.indexOf(Graphics.quality);
      if (i > 0) {
        applyDetected(tiers[i - 1]);
        console.info(`[myco] graphics quality stepped down to "${tiers[i - 1]}" to keep the frame rate up.`);
      }
      this.monitor.steppedDown();
      this.monitor.setAtLowest(atLowest());
    }
    return true;
  }

  private stop(): false {
    this.stopped = true;
    return false;
  }
}
