// Source text helpers the stylesheet parser and the cascade share (ADR 0077, 0423): the line and column of a
// problem. Pure, with no parser behind it, so the cascade (`cascade.ts`) can use it without loading css-tree.
// Paths a document names resolve through `core/projectPath.ts` (ADR 0466).
import type { SourceProblem, SourceSpan } from "./types";

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
