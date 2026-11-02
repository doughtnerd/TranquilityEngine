import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Plugin } from "vite";

/**
 * Compile TypeScript (and TSX) with tsc instead of Vite's default transformer (oxc), which does
 * not lower standard ES decorators (used for scene field declarations, see ADR 0013). JSX is
 * compiled for Preact, which the editor UI uses (ADR 0025). Used by the dev server, all builds
 * and Vitest, so they emit the same code. Configs that use it must also set `oxc: false`.
 */
export function typescriptTranspile(): Plugin {
  return {
    name: "tranquility:tsc-transpile",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0];
      const isTs = file.endsWith(".ts") || file.endsWith(".tsx");
      if (!isTs || file.endsWith(".d.ts") || file.includes("node_modules")) return null;
      const out = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          useDefineForClassFields: true,
          jsx: ts.JsxEmit.ReactJSX,
          jsxImportSource: "preact",
          sourceMap: true,
          inlineSources: true,
        },
      });
      return { code: out.outputText, map: out.sourceMapText ? JSON.parse(out.sourceMapText) : null };
    },
  };
}

/** The module the editor imports the engine's declarations from (ADR 0030). */
const ENGINE_TYPES = "virtual:tranquility-types";

/**
 * The engine's public type declarations as a virtual module, `virtual:tranquility-types`: an
 * object of `.d.ts` text by path (`index.d.ts`, `core/World.d.ts`, ...), emitted in memory with
 * `tsconfig.engine.json`'s settings (internals stripped, editor access left out). The editor's
 * code editor serves them as the `"tranquility"` package (ADR 0030). Regenerated when an engine
 * source file changes.
 */
export function engineTypes(): Plugin {
  const resolved = `\0${ENGINE_TYPES}`;
  return {
    name: "tranquility:engine-types",
    resolveId: (id) => (id === ENGINE_TYPES ? resolved : null),
    load(id) {
      if (id !== resolved) return null;
      const config = ts.getParsedCommandLineOfConfigFile(fileURLToPath(new URL("./tsconfig.engine.json", import.meta.url)), {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => {
          throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
        },
      });
      if (!config) throw new Error("tsconfig.engine.json: couldn't read it.");
      const program = ts.createProgram({ rootNames: config.fileNames, options: { ...config.options, noEmit: false, declaration: true, emitDeclarationOnly: true } });
      const outDir = config.options.outDir!.replace(/\\/g, "/");
      const files: Record<string, string> = {};
      program.emit(undefined, (fileName, text) => {
        const rel = fileName.replace(/\\/g, "/");
        files[rel.startsWith(`${outDir}/`) ? rel.slice(outDir.length + 1) : rel] = text;
      });
      for (const f of config.fileNames) this.addWatchFile(f);
      return `export default ${JSON.stringify(files)};`;
    },
  };
}

/** A sample project (ADR 0031) as the editor's start screen lists it. */
export interface SampleInfo {
  /** Its folder name under samples/. */
  id: string;
  name: string;
  description?: string;
  /** Every file, project-relative, with its size in bytes. */
  files: { path: string; size: number }[];
}

const SAMPLES_DIR = fileURLToPath(new URL("./samples/", import.meta.url));
/** Left out of samples: hidden folders (the editor's .tranquility/), and the tsconfig.json the editor writes when a copy opens. sample.json is read for the list. */
const skipSampleFile = (path: string) => path.split("/").some((part) => part.startsWith(".") || part === "node_modules") || path === "tsconfig.json";

function sampleFiles(dir: string, root = dir): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const path = relative(root, full).split(sep).join("/");
    if (skipSampleFile(path)) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...sampleFiles(full, root));
    else out.push({ path, size: stat.size });
  }
  return out;
}

/** Every folder under samples/ with a project.json. */
export function sampleManifest(): { samples: SampleInfo[] } {
  if (!existsSync(SAMPLES_DIR)) return { samples: [] };
  const samples: SampleInfo[] = [];
  for (const id of readdirSync(SAMPLES_DIR).sort()) {
    const dir = join(SAMPLES_DIR, id);
    if (!existsSync(join(dir, "project.json"))) continue;
    const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as { name?: string };
    const extra = existsSync(join(dir, "sample.json")) ? (JSON.parse(readFileSync(join(dir, "sample.json"), "utf8")) as { name?: string; description?: string }) : {};
    samples.push({ id, name: extra.name ?? project.name ?? id, description: extra.description, files: sampleFiles(dir).filter((f) => f.path !== "sample.json") });
  }
  return { samples };
}

const SAMPLE_TYPES: Record<string, string> = { json: "application/json", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav" };

/**
 * Ship the sample projects in samples/ beside the editor (ADR 0031), never inside it: the dev
 * server serves them at /samples/ as they are on disk (scripts as source text, not compiled), and
 * builds copy them to `samples/` in the output. `/samples/index.json` lists them (`sampleManifest`).
 */
export function samples(): Plugin {
  return {
    name: "tranquility:samples",
    configureServer(server) {
      // Before Vite's own middleware, which would compile the scripts.
      server.middlewares.use("/samples", (req, res, next) => {
        const url = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
        const manifest = sampleManifest();
        if (url === "index.json") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(manifest));
          return;
        }
        const [id, ...rest] = url.split("/");
        const path = rest.join("/");
        if (!manifest.samples.some((s) => s.id === id && s.files.some((f) => f.path === path))) return next();
        res.setHeader("Content-Type", SAMPLE_TYPES[path.split(".").pop()!.toLowerCase()] ?? "text/plain; charset=utf-8");
        res.end(readFileSync(join(SAMPLES_DIR, id, ...rest)));
      });
    },
    generateBundle() {
      const manifest = sampleManifest();
      this.emitFile({ type: "asset", fileName: "samples/index.json", source: JSON.stringify(manifest) });
      for (const sample of manifest.samples) {
        for (const file of sample.files) {
          this.emitFile({ type: "asset", fileName: `samples/${sample.id}/${file.path}`, source: readFileSync(join(SAMPLES_DIR, sample.id, file.path)) });
        }
      }
    },
  };
}
