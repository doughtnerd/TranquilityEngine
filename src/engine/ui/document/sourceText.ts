// Source text helpers the UI document parsers and the cascade share (ADR 0077): project-relative path
// resolution, line and column of a problem, and `{name}` bindings in attribute values. Pure, with no
// parser behind them, so the cascade (`cascade.ts`) can use them without loading `htmlparser2`.
import type { BindingPart, ParseBindings, SourceProblem, SourceSpan } from "./types";

/** The folder part of a project path (`ui/menu.ui.xml` → `ui/`). */
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


export const parseBindings: ParseBindings = (value) => {
  const parts: BindingPart[] = [];
  let text = "";
  let i = 0;
  while (i < value.length) {
    const c = value[i];
    if (c === "{" && value[i + 1] === "{") {
      text += "{";
      i += 2;
    } else if (c === "}" && value[i + 1] === "}") {
      text += "}";
      i += 2;
    } else if (c === "{") {
      const close = value.indexOf("}", i + 1);
      const name = close < 0 ? "" : value.slice(i + 1, close).trim();
      if (close < 0 || !/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(name)) {
        text += c; // not a binding: kept as written
        i++;
        continue;
      }
      if (text) parts.push({ text });
      text = "";
      parts.push({ binding: name });
      i = close + 1;
    } else {
      text += c;
      i++;
    }
  }
  if (text || parts.length === 0) parts.push({ text });
  return parts;
};

/** True when a value has a `{name}` binding. */
export function hasBinding(value: string): boolean {
  return parseBindings(value).some((p) => "binding" in p);
}

