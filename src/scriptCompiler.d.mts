// Types for scriptCompiler.mjs (ADR 0332), so TypeScript hosts import it under strict mode.

/** Compiler settings in tsconfig spelling. */
export interface ScriptSettings {
  readonly target: "ES2022" | "ESNext";
  readonly module: "ESNext";
  readonly useDefineForClassFields: boolean;
  readonly moduleResolution?: "Bundler";
  readonly lib?: readonly string[];
  readonly strict?: boolean;
  readonly resolveJsonModule?: boolean;
}

/** What every host emits: ES2022 modules with define-semantics class fields and standard decorators lowered. */
export const SCRIPT_EMIT: ScriptSettings;

/** What checkers type-check scripts with: the emit settings plus Bundler resolution, ES2022 + DOM libs, strict, JSON imports. */
export const SCRIPT_CHECK: Required<ScriptSettings>;

/**
 * `settings` as the compiler API takes them (enums as TypeScript's numbers, libs as file names), as
 * `ts.convertCompilerOptionsFromJson` gives. Structurally a `ts.CompilerOptions`.
 */
export function compilerOptions(settings: ScriptSettings): {
  target: number;
  module: number;
  useDefineForClassFields: boolean;
  moduleResolution?: number;
  lib?: string[];
  strict?: boolean;
  resolveJsonModule?: boolean;
};

/** The files a relative import whose target is `base` may name, best first: as written, `.ts` added, `.js` → `.ts`, `/index.ts`. */
export function relativeImportCandidates(base: string): string[];
