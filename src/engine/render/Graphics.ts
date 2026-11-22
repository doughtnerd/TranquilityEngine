/**
 * Graphics quality (ADR 0050): which of the project's quality tiers is active. Like `Storage`, it
 * belongs to the player and the process, not to a World (ADR 0032): every render backend applies
 * the same tier. Setting `Graphics.quality` applies the tier at once and saves the choice, so it
 * comes back the next time the game starts. Automatic quality (ADR 0055, 0322) is `autoQuality.ts`.
 */
import { defaultGraphics, detectPlatform, type Platform, type GraphicsSettings, type QualityTier } from "../core/graphics";
import { Storage } from "../platform/Storage";
import { detectedTier } from "./autoQuality";

/** The Storage key (namespace "settings") holding the player's chosen tier. */
export const QUALITY_KEY = "graphics.quality";

let settings: GraphicsSettings = defaultGraphics();
let current: QualityTier = settings.tiers.find((t) => t.name === settings.defaultTier)!;
let version = 0;
let autoDetected = false;
let platform: Platform = "web";
let effectiveDefault = settings.defaultTier;

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
   * GPU's name, cores and memory, where "the default" is this platform's default tier. It doesn't
   * apply it; set `Graphics.quality` to use it.
   */
  static detectQuality(): string {
    return detectedTier();
  }

  /** @internal Automatic quality (ADR 0322): apply a tier as detected, not as the player's choice. False if there's no such tier. */
  static _applyDetected(name: string): boolean {
    if (!Graphics._apply(name)) return false;
    autoDetected = true;
    return true;
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
