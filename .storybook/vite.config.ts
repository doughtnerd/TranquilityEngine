// The Vite config Storybook builds with (ADR 0219), in place of the dev server's vite.config.ts (which also serves the
// samples and the player): the editor's settings for rendering its components, `componentViteConfig`.
import { defineConfig } from "vite";
import { componentViteConfig } from "../vite.shared.ts";

export default defineConfig(componentViteConfig());
