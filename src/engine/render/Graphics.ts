/**
 * Graphics quality (ADR 0050): which of the project's quality tiers is active. Like `Storage`, it
 * belongs to the player and the process, not to a World (ADR 0032): every render backend applies
 * the same tier. Setting `Graphics.quality` applies the tier at once and saves the choice, so it
 * comes back the next time the game starts.
 */
import { defaultGraphics, type GraphicsSettings, type QualityTier } from "../core/graphics";
import { Storage } from "../platform/Storage";

/** The Storage key (namespace "settings") holding the player's chosen tier. */
export const QUALITY_KEY = "graphics.quality";

let settings: GraphicsSettings = defaultGraphics();
let current: QualityTier = settings.tiers.find((t) => t.name === settings.defaultTier)!;
let version = 0;

const pick = (name: string | undefined): QualityTier | undefined => (name === undefined ? undefined : settings.tiers.find((t) => t.name === name));

export class Graphics {
  /** @internal Set by the Engine from `project.json`, with the player's saved choice if it still names a tier. */
  static _configure(graphics: GraphicsSettings, saved?: unknown): void {
    settings = graphics;
    current = pick(typeof saved === "string" ? saved : undefined) ?? pick(graphics.defaultTier) ?? graphics.tiers[0];
    version++;
  }

  /** @internal Bumped whenever the active tier or its values change, so render backends re-apply it. */
  static get _version(): number {
    return version;
  }

  /** The tiers' names, lowest first. */
  static get tiers(): readonly string[] {
    return settings.tiers.map((t) => t.name);
  }

  /** The project's default tier: the one used until the player picks another. */
  static get defaultQuality(): string {
    return settings.defaultTier;
  }

  /** The active tier's name. Setting it applies that tier now and saves it as the player's choice; an unknown name is ignored with a warning. */
  static get quality(): string {
    return current.name;
  }

  static set quality(name: string) {
    if (!Graphics._apply(name)) return;
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
