// The engine's built-in UI components in the editor (ADR 0419 wave B, `projectCode/builtinUI.ts`): a plugin's editor half
// starts loading its component (compiled with the editor's build) when it activates, and the editor's project code load
// (`thirdPartyEditor.ts`'s `loadProjectCode`, which every script load and reload goes through) waits for every load
// started so far, as it waits for the plugins' audio effects and animation nodes. So Play, which runs on loaded code,
// never starts before the components are served, and no load is left running after the work that started it. Editor
// code only.

const pending = new Set<Promise<void>>();

/** Start loading a built-in UI module (`() => import("../builtinUI")`), which serves its component when it runs. */
export function loadBuiltinUI(load: () => Promise<unknown>): void {
  const loading: Promise<void> = load().then(
    () => {},
    (err: unknown) => console.error("[editor] a built-in UI component didn't load:", err),
  );
  pending.add(loading);
  void loading.finally(() => pending.delete(loading));
}

/** Resolves once every built-in UI load started so far (and any started meanwhile) has finished. */
export async function builtinUIReady(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}
