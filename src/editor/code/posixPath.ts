// Node's `path` (POSIX) for svelte2tsx in the browser (ADR 0428): it imports `path` for file names (`basename`), and
// the editor's builds resolve that import here (`svelteCheckPath()` in vite.shared.ts). Project paths are POSIX
// (`ui/Hud.svelte`), so only the POSIX half is written.

export const sep = "/";
export const delimiter = ":";

export const isAbsolute = (path: string): boolean => path.startsWith("/");

/** `path` with `.` and `..` segments folded and repeated slashes dropped. */
export function normalize(path: string): string {
  const absolute = isAbsolute(path);
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else if (part !== ".." || !absolute) out.push(part);
  }
  const joined = out.join("/");
  return absolute ? `/${joined}` : joined || ".";
}

export const join = (...parts: string[]): string => normalize(parts.filter(Boolean).join("/"));

/** The parts joined from the right until one is absolute; relative to `/` (there's no working directory here). */
export function resolve(...parts: string[]): string {
  let path = "";
  for (let i = parts.length - 1; i >= 0 && !isAbsolute(path); i--) if (parts[i]) path = path ? `${parts[i]}/${path}` : parts[i];
  return normalize(isAbsolute(path) ? path : `/${path}`);
}

export function relative(from: string, to: string): string {
  const a = resolve(from).split("/").filter(Boolean);
  const b = resolve(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

export function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  return at < 0 ? "." : at === 0 ? "/" : trimmed.slice(0, at);
}

export function basename(path: string, ext?: string): string {
  const base = path.replace(/\/+$/, "").split("/").pop() ?? "";
  return ext && base.endsWith(ext) && base !== ext ? base.slice(0, -ext.length) : base;
}

export function extname(path: string): string {
  const base = basename(path);
  const at = base.lastIndexOf(".");
  return at <= 0 ? "" : base.slice(at);
}

/** Node's `path.parse`: `{ root, dir, base, ext, name }` (svelte2tsx names a component's class from `name`). */
export function parse(path: string): { root: string; dir: string; base: string; ext: string; name: string } {
  const root = isAbsolute(path) ? "/" : "";
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const at = trimmed.lastIndexOf("/");
  const base = at < 0 ? trimmed : trimmed.slice(at + 1);
  const dir = at < 0 ? "" : at === 0 ? "/" : trimmed.slice(0, at);
  const dot = base.lastIndexOf(".");
  const ext = dot <= 0 ? "" : base.slice(dot);
  return { root, dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
}

/** Node's `path.format`, the inverse of `parse`. */
export function format(p: { root?: string; dir?: string; base?: string; ext?: string; name?: string }): string {
  const base = p.base ?? `${p.name ?? ""}${p.ext ?? ""}`;
  const dir = p.dir ?? p.root ?? "";
  return dir ? (dir === p.root ? `${dir}${base}` : `${dir}/${base}`) : base;
}

const path = {
  sep,
  delimiter,
  isAbsolute,
  normalize,
  join,
  resolve,
  relative,
  dirname,
  basename,
  extname,
  parse,
  format,
  get posix(): typeof path {
    return path;
  },
};
export const posix = path;
export default path;
