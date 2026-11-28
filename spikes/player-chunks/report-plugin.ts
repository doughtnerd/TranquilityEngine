// Records per-chunk and per-module rendered sizes (after tree-shaking/minify) into a JSON file.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import type { Plugin } from "vite";

export function chunkReport(out: string): Plugin {
  return {
    name: "spike:chunk-report",
    enforce: "post",
    generateBundle(_o, bundle) {
      const rows: unknown[] = [];
      const gz = (s: string | Uint8Array) => gzipSync(s, { level: 9 }).length;
      const br = (s: string | Uint8Array) => brotliCompressSync(s, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
      for (const [file, c] of Object.entries(bundle)) {
        if (c.type === "chunk") {
          const modules = Object.entries(c.modules).map(([id, m]) => ({ id, rendered: m.renderedLength }));
          rows.push({ file, name: c.name, entry: c.isEntry, dynamic: c.isDynamicEntry, raw: Buffer.byteLength(c.code), gzip: gz(c.code), brotli: br(c.code), imports: c.imports, dynamicImports: c.dynamicImports, modules });
        } else {
          rows.push({ file, name: c.name, asset: true, raw: Buffer.byteLength(c.source), gzip: gz(c.source), brotli: br(c.source) });
        }
      }
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(rows, null, 1));
    },
  };
}
