/**
 * The game UI's render feature spec (ADR 0130), apart from the feature so the renderer can register it
 * without pulling Yoga, Babylon GUI or `UICore` into the main bundle (`uiFeature.ts` loads on first need).
 */
import { isUIComponent, UICanvas } from "../../ui/components";
import { Text } from "../components";
import type { RenderFeatureSpec } from "../renderFeatures";

/** @internal Screen and world UI canvases and their elements, and `Text`. */
export const UI_SPEC: RenderFeatureSpec = {
  name: "ui",
  phase: "overlay",
  types: [UICanvas, Text],
  owns: (c) => isUIComponent(c) || c instanceof Text,
  lazy: true,
  holdsFirstFrame: true,
};
