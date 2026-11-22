// The `InputContext` component's `context` field in the Inspector (ADR 0336, 0152): a dropdown of the project's
// `*.input.json` files and the contexts scripts register with `defineInputContext`. Registered with the built-in
// Inspector sections (`ui/inspectorSections.builtin.ts`).
import { inputContextNames } from "../engine/editor";
import { INPUT_CONTEXT_EXTENSION } from "./inputContextKind";
import type { FieldChoicesContribution } from "./sdk/contributions";
import { currentProject, docVersion } from "./state";

/** The project's context files, then the contexts registered in code (the default context is always on, so it isn't offered). */
export function inputContextChoices(files: readonly string[]): { label: string; value: string }[] {
  const assets = files.filter((f) => f.endsWith(INPUT_CONTEXT_EXTENSION)).sort();
  const registered = inputContextNames().filter((n) => n !== "default" && !assets.includes(n));
  return [...assets.map((f) => ({ label: f, value: f })), ...registered.map((n) => ({ label: `${n} (in code)`, value: n }))];
}

/** `InputContext.context`: a dropdown of the project's context files and the registered contexts. */
export const inputContextFieldChoices: FieldChoicesContribution = {
  id: "input-context-context",
  type: "engine.InputContext",
  field: "context",
  none: { label: "None", value: "" },
  // The choices follow the project's files (and scripts registering contexts, which reload with them).
  key: () => {
    docVersion.value;
    return inputContextChoices(currentProject.value?.files ?? []).map((c) => c.value).join("\n");
  },
  choices: () => inputContextChoices(currentProject.peek()?.files ?? []),
};
