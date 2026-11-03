// Editing scripts outside the editor (ADR 0030). A project folder gets a `tsconfig.json` and the
// engine's declarations, so VS Code (or any TypeScript editor) types scripts the way the Code
// panel does; the desktop editor watches `scripts/` and reloads what changes, whatever wrote it;
// and a script can be opened in the system's code editor.
import type { FileSystem } from "../engine/platform/FileSystem";
import { hashText } from "./document";
import { joinPath } from "./projects";

/** Where the engine's declarations go in a project, served to TypeScript as the `"myco"` package. */
export const TYPES_DIR = ".myco/types/myco";

/** The `tsconfig.json` a project gets (only if it has none): scripts compiled as the editor compiles them. */
export function projectTsconfig(): string {
  const config = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      lib: ["ES2022", "DOM"],
      strict: true,
      noEmit: true,
      useDefineForClassFields: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      // "tranquility": the engine's former name (ADR 0037), for scripts written before the rename.
      paths: { myco: [`./${TYPES_DIR}/index.d.ts`], tranquility: [`./${TYPES_DIR}/index.d.ts`] },
    },
    include: ["scripts/**/*.ts"],
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Give a project folder what external editors need: a `scripts/` folder, a `tsconfig.json` (left
 * alone if there is one), and the engine's `declarations` (path → `.d.ts` text) under
 * `TYPES_DIR`, rewritten only when they changed (a stamp file holds their hash). Returns what was
 * written.
 */
export async function writeScriptingFiles(fs: FileSystem, root: string, declarations: Readonly<Record<string, string>>): Promise<{ tsconfig: boolean; types: boolean }> {
  await fs.mkdir(joinPath(root, "scripts"));
  const result = { tsconfig: false, types: false };
  if (!(await fs.exists(joinPath(root, "tsconfig.json")))) {
    await fs.writeText(joinPath(root, "tsconfig.json"), projectTsconfig());
    result.tsconfig = true;
  }
  const stamp = hashText(JSON.stringify(declarations));
  const stampPath = joinPath(root, `${TYPES_DIR}/.stamp`);
  const current = (await fs.exists(stampPath)) ? (await fs.readText(stampPath)).trim() : null;
  if (current !== stamp) {
    for (const [path, text] of Object.entries(declarations)) {
      const file = joinPath(root, `${TYPES_DIR}/${path}`);
      await fs.mkdir(file.slice(0, Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"))));
      await fs.writeText(file, text);
    }
    await fs.writeText(joinPath(root, `${TYPES_DIR}/package.json`), `${JSON.stringify({ name: "myco", types: "index.d.ts" }, null, 2)}\n`);
    await fs.writeText(stampPath, `${stamp}\n`);
    result.types = true;
  }
  return result;
}

/**
 * Watch a project's `scripts/` folder and call `onChange` when a script changes there (created,
 * edited, renamed or deleted). Returns a function that stops watching, or null when the file
 * system can't watch (a plain browser).
 */
export async function watchScripts(fs: FileSystem, root: string, onChange: () => void): Promise<(() => void) | null> {
  if (!fs.watch) return null;
  // By file name: a script, not a declaration file or the temp file of an atomic write (`X.ts.tmp-…`).
  return fs.watch(joinPath(root, "scripts"), (paths) => {
    if (paths.some((p) => /\.ts$/i.test(p) && !/\.d\.ts$/i.test(p))) onChange();
  });
}
