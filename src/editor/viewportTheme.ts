// The viewport follows the editor theme (theme.ts): background, grid, selection outline and camera
// gizmo colours, set on the Editor World's render backend whenever the theme changes.
import { effect } from "@preact/signals";
import type { Engine } from "../engine";
import { viewport } from "../engine/editor";
import { theme, viewportColors } from "./theme";

/** Keep the Editor World's viewport colours in line with the theme. Returns a function that stops. */
export function installViewportTheme(engine: Engine): () => void {
  return effect(() => {
    const { background, grid, gridCenter, outline, cameraGizmo } = viewportColors(theme.value);
    viewport(engine.world).setColors({ background, grid, gridCenter, outline, cameraGizmo });
  });
}
