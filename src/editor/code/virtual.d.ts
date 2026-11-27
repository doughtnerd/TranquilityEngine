/** The engine's public declarations by path (`index.d.ts`, …), from the `engineTypes()` Vite plugin (ADR 0030). */
declare module "virtual:myco-types" {
  const files: Record<string, string>;
  export default files;
}

/** The engine's files a game's UI bundle reads, by path from the engine's root, from the `uiRuntimeFiles()` Vite plugin (ADR 0425). */
declare module "virtual:myco-ui-runtime" {
  const files: Record<string, string>;
  export default files;
}
