// First-party plugins' editor halves (ADR 0133). Editor code only: never imported by runtime code
// (the player, the server, the engine). `main.tsx` activates this list before the layout loads.
import type { EditorPlugin } from "../editor/sdk/plugins";
import { skyEditorPlugin } from "./sky/editor";

export const EDITOR_PLUGINS: readonly EditorPlugin[] = [skyEditorPlugin];
