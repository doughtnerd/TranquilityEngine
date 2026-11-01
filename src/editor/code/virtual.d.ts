/** The engine's public declarations by path (`index.d.ts`, …), from the `engineTypes()` Vite plugin (ADR 0030). */
declare module "virtual:tranquility-types" {
  const files: Record<string, string>;
  export default files;
}
