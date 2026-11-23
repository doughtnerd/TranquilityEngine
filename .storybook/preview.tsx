// Every story renders inside the editor's theme (ADR 0219), as a panel does in the editor: the theme tokens as CSS
// custom properties on :root (`installTheme`, the same call the editor's boot makes), the editor's stylesheet, and a
// toolbar switch between the built-in presets (Settings > Appearance's list). The switch sets the editor's own theme
// preference, so a story sees exactly what a user who picked that preset sees.
import type { Decorator, Preview } from "@storybook/preact-vite";
import { useEffect } from "preact/hooks";
import { PRESETS, installTheme, themePreset } from "../src/editor/theme";
import "../src/editor/ui/editor.css";

installTheme(document.documentElement);

const withEditorTheme: Decorator = (Story, context) => {
  const id = String(context.globals.theme ?? PRESETS[0].id);
  themePreset.value = id;
  useEffect(() => {
    document.body.style.background = "var(--panel)";
    document.body.style.color = "var(--text)";
  }, []);
  return (
    // Studio stories get the Studio's form controls (src/studio/components/formControls.css), as the Studio page does.
    <div class={`myco-story${context.title.startsWith("Studio") ? " studio-forms" : ""}`} style={{ fontFamily: "var(--font-ui)", fontSize: "var(--font-size-ui)", padding: "8px" }}>
      <Story />
    </div>
  );
};

const preview: Preview = {
  decorators: [withEditorTheme],
  globalTypes: {
    theme: {
      description: "Editor theme",
      toolbar: { title: "Theme", icon: "paintbrush", items: PRESETS.map((p) => ({ value: p.id, title: p.name })), dynamicTitle: true },
    },
  },
  initialGlobals: { theme: PRESETS[0].id },
  parameters: { layout: "fullscreen" },
};

export default preview;
