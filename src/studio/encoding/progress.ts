// Convert now's progress, read from the export's audio step's lines (ADR 0337 §5 step 4: "with progress lines"):
// `audio: <path> → vorbis [3/12]` or `audio: <path> (cached) [4/12]`. Pure.

/** The counts a progress line carries, or null for any other line. */
export function convertProgress(line: string): { done: number; total: number } | null {
  const m = /^audio: .*\[(\d+)\/(\d+)\]$/.exec(line);
  if (!m) return null;
  const done = Number(m[1]), total = Number(m[2]);
  return total > 0 && done <= total ? { done, total } : null;
}
