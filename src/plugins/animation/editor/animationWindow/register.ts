// Editor registration seam: animationWindow (T50). Registers the Animation window: dope sheet, curves, record mode, event, marker, audio and activation rows, onion skin.
// The editor half's `activate()` (`../index.ts`) calls it once per activation; empty until T50.
import type { EditorPluginContext } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";

/** @internal */
export function registerAnimationWindow(_context: EditorPluginContext, _on: AnimationEditorIntegrations): void {}
