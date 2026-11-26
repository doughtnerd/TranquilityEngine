// Source text helpers the stylesheet parser and the cascade share (ADR 0077, 0419): project-relative path
// resolution and the line and column of a problem. Pure, with no parser behind them, so the cascade
// (`cascade.ts`) can use them without loading css-tree.
import type { SourceProblem, SourceSpan } from "./types";

/** The folder part of a project path (`ui/Hud.svelte` → `ui/`). */
function folderOf(file: string): string {
  const i = file.lastIndexOf("/");
  return i < 0 ? "" : file.slice(0, i + 1);
}

/** Resolve `src` against the file that has it; `/` at the start means the project root. `..` and `.` resolve. */
export function resolvePath(file: string, src: string): string {
  const raw = src.replace(/^asset:/, "");
  const joined = raw.startsWith("/") ? raw.slice(1) : folderOf(file) + raw;
  const out: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** 1-based line and column of an offset. */
function lineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

export function problemAt(source: string, file: string, span: SourceSpan, message: string): SourceProblem {
  const { line, column } = lineColumn(source, span.start);
  return { message: `${file}:${line}:${column}: ${message}`, line, column, span };
}
