// The UI plugin's light warm-up (ADR 0080, 0154): a world-space canvas's plane, made with the GUI
// drawing module alone, so a scene load warms world UI before the UI feature (Yoga, the font, a live GUI
// layer) has loaded: the canvas may be in a prefab that hasn't spawned yet.
import type { BabylonWarmFactory } from "../../../engine/render/babylon/feature";
import { worldCanvasWarm } from "../../../engine/render/babylon/ui";

/** @internal What the renderer warms world UI with until the UI feature has loaded. */
export const createUIWarm: BabylonWarmFactory = (host) => ({ warm: (content) => worldCanvasWarm(host.scene, content) });
