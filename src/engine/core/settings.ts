import type { BootstrapSetting } from "./worlds";

/** Project settings, normally loaded from the game's `project.json`. */
export interface ProjectSettings {
  name: string;
  display: {
    /** Reference resolution. The canvas keeps this aspect ratio and scales to fit its container. */
    width: number;
    height: number;
    backgroundColor: string;
  };
  time: {
    fixedDeltaTime: number;
    maxSubSteps: number;
    maxFrameTime: number;
  };
  physics: {
    gravity: [number, number];
    /** Named collision layers (max 16). Index 0 is the default layer. */
    layers: string[];
    /**
     * Which layers collide, as symmetric pairs: `{ "Player": ["Ground", "Obstacle"] }`.
     * When omitted, every layer collides with every other layer.
     */
    collisionMatrix?: Record<string, string[]>;
  };
  render: {
    /** Sorting layers from back to front (ADR 0014). */
    sortingLayers: string[];
    /** Default sprite pixels per world unit (ADR 0014). */
    pixelsPerUnit: number;
  };
  /** Scene/prefab files instanced under the World root at startup; they persist across scene loads (ADR 0016). */
  autoload: string[];
  /** Which Worlds the Engine creates at start (ADR 0032). Omitted: the default bootstrap, one World. */
  bootstrap?: BootstrapSetting;
}

export type ProjectSettingsInput = {
  [K in keyof ProjectSettings]?: ProjectSettings[K] extends object[] | string[]
    ? ProjectSettings[K]
    : ProjectSettings[K] extends object
      ? Partial<ProjectSettings[K]>
      : ProjectSettings[K];
};

export const defaultSettings: ProjectSettings = {
  name: "Untitled",
  display: { width: 1280, height: 720, backgroundColor: "#000000" },
  time: { fixedDeltaTime: 1 / 60, maxSubSteps: 5, maxFrameTime: 0.25 },
  physics: { gravity: [0, -9.81], layers: ["Default"] },
  render: { sortingLayers: ["Default"], pixelsPerUnit: 100 },
  autoload: [],
};

export function resolveSettings(input: ProjectSettingsInput = {}): ProjectSettings {
  return {
    name: input.name ?? defaultSettings.name,
    display: { ...defaultSettings.display, ...input.display },
    time: { ...defaultSettings.time, ...input.time },
    physics: { ...defaultSettings.physics, ...input.physics },
    render: { ...defaultSettings.render, ...input.render },
    autoload: input.autoload ?? [],
    ...(input.bootstrap !== undefined ? { bootstrap: input.bootstrap } : {}), // validated by the bootstrap (T4)
  };
}
