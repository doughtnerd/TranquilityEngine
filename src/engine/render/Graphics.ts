/**
 * Graphics quality (ADR 0050): which of the project's quality tiers is active. Like `Storage`, it
 * belongs to the player and the process, not to a World (ADR 0032): every render backend applies
 * the same tier. Setting `Graphics.quality` applies the tier at once and saves the choice, so it
 * comes back the next time the game starts.
 */
import { defaultGraphics, detectPlatform, type Platform, type GraphicsSettings, type QualityTier } from "../core/graphics";
import { Storage } from "../platform/Storage";
import { guessTier, tierForGuess, type DeviceInfo } from "./qualityDetect";

/** The Storage key (namespace "settings") holding the player's chosen tier. */
export const QUALITY_KEY = "graphics.quality";
/** The Storage key (namespace "settings") holding the tier automatic detection chose (ADR 0055). */
export const AUTO_QUALITY_KEY = "graphics.autoQuality";

let settings: GraphicsSettings = defaultGraphics();
let current: QualityTier = settings.tiers.find((t) => t.name === settings.defaultTier)!;
let version = 0;
let autoDetected = false;
let device: DeviceInfo | null = null;
let platform: Platform = "web";
let effectiveDefault = settings.defaultTier;

/** What the browser says about the machine (ADR 0055): the GPU's name, cores, memory and screen. Read once. */
function deviceInfo(): DeviceInfo {
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
    // No GPU name: the guess falls back to the project's default.
  }
  return (device = info);
}

const pick = (name: string | undefined): QualityTier | undefined => (name === undefined ? undefined : settings.tiers.find((t) => t.name === name));

export class Graphics {
  /**
   * @internal Set by the Engine from `project.json`, with the player's saved choice if it still
   * names a tier, else (with `autoDetect`) the tier detection chose earlier (ADR 0055).
   */
  static _configure(graphics: GraphicsSettings, saved?: unknown, auto?: unknown, where: Platform = detectPlatform()): void {
    settings = graphics;
    platform = where;
    const forPlatform = graphics.platformDefaults?.[where];
    effectiveDefault = pick(forPlatform) ? forPlatform! : graphics.defaultTier;
    const player = pick(typeof saved === "string" ? saved : undefined);
    const detected = graphics.autoDetect && !player ? pick(typeof auto === "string" ? auto : undefined) : undefined;
    current = player ?? detected ?? pick(effectiveDefault) ?? graphics.tiers[0];
    autoDetected = !!detected;
    version++;
  }

  /** True when the active tier was chosen by automatic detection (ADR 0055) rather than the player or the project's default. */
  static get autoDetected(): boolean {
    return autoDetected;
  }

  /**
   * The tier the machine's GPU suggests (ADR 0055), among the project's tiers: a guess from the
   * GPU's name, cores and memory. It doesn't apply it; set `Graphics.quality` to use it.
   */
  static detectQuality(): string {
    return tierForGuess(guessTier(deviceInfo()).guess, Graphics.tiers, settings.defaultTier);
  }

  /** @internal The Engine's automatic detection: apply a tier and remember it as detected, not as the player's choice. */
  static _applyDetected(name: string): void {
    if (!Graphics._apply(name)) return;
    autoDetected = true;
    void Storage.save(AUTO_QUALITY_KEY, name, "settings").catch(() => undefined);
  }

  /** @internal Bumped whenever the active tier or its values change, so render backends re-apply it. */
  static get _version(): number {
    return version;
  }

  /** The tiers' names, lowest first. */
  static get tiers(): readonly string[] {
    return settings.tiers.map((t) => t.name);
  }

  /** The default tier: the one used until the player picks another. The project's default for this platform (`platformDefaults`) if it sets one, else `defaultTier`. */
  static get defaultQuality(): string {
    return effectiveDefault;
  }

  /** Where the game runs (desktop, mobile or web), as detected when the project was configured. */
  static get platform(): Platform {
    return platform;
  }

  /** The active tier's name. Setting it applies that tier now and saves it as the player's choice; an unknown name is ignored with a warning. */
  static get quality(): string {
    return current.name;
  }

  static set quality(name: string) {
    if (!Graphics._apply(name)) return;
    autoDetected = false;
    void Storage.save(QUALITY_KEY, name, "settings").catch((err) => console.warn("[myco] couldn't save the graphics quality:", err));
  }

  /** The active tier's settings. */
  static get tier(): Readonly<QualityTier> {
    return current;
  }

  /** @internal Apply a tier without saving it (the editor's quality preview). False if there's no such tier. */
  static _apply(name: string): boolean {
    const tier = pick(name);
    if (!tier) {
      console.warn(`[myco] there's no graphics quality "${name}"; the tiers are ${Graphics.tiers.map((t) => `"${t}"`).join(", ")}.`);
      return false;
    }
    if (tier !== current) {
      current = tier;
      version++;
    }
    return true;
  }
}
