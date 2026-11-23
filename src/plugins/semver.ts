// Semver versions and npm-style ranges (ADR 0139), shared by the third-party plugin checks and the plugin set's
// optional dependencies (ADR 0374). Pure: no engine and no editor imports.

type Version = readonly [number, number, number, string];

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A full `x.y.z[-pre][+build]` version, or null. */
export function parseVersion(text: string): Version | null {
  const m = VERSION_RE.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""] : null;
}

/** Negative, zero or positive as `a` is before, equal to or after `b` (a pre-release sorts before its release). */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  if (a[3] === b[3]) return 0;
  if (!a[3]) return 1;
  if (!b[3]) return -1;
  return a[3] < b[3] ? -1 : 1;
}

type Op = ">=" | ">" | "<=" | "<" | "=";
type Comparator = readonly [Op, Version];

const PARTIAL_RE = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A possibly partial version: the numbers given, up to the first wildcard or missing part. */
function parsePartial(text: string): { parts: number[]; pre: string } | null {
  const m = PARTIAL_RE.exec(text);
  if (!m) return null;
  const parts: number[] = [];
  for (const p of [m[1], m[2], m[3]]) {
    if (p === undefined || /^[xX*]$/.test(p)) break;
    parts.push(Number(p));
  }
  return { parts, pre: parts.length === 3 ? (m[4] ?? "") : "" };
}

const v = (a: number, b = 0, c = 0, pre = ""): Version => [a, b, c, pre];

/** One range token ("^1.2.3", ">=2", "1.x", "*") as comparators, or null when it isn't one. */
function tokenComparators(token: string): Comparator[] | null {
  if (token === "" || token === "*" || /^[xX]$/.test(token)) return [];
  const m = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(token)!;
  const op = m[1] ?? "";
  const partial = parsePartial(m[2]!);
  if (!partial) return null;
  const [a, b, c] = partial.parts;
  const n = partial.parts.length;
  if (n === 0) return op === "<" || op === ">" ? [["<", v(0, 0, 0, "0")]] : [];
  const low = v(a!, b ?? 0, c ?? 0, partial.pre);
  /** The first version past the partial's last given part. */
  const next = n === 1 ? v(a! + 1) : n === 2 ? v(a!, b! + 1) : v(a!, b!, c! + 1);
  switch (op) {
    case "^": {
      const upper = a! > 0 || n === 1 ? v(a! + 1) : b! > 0 || n === 2 ? v(0, b! + 1) : v(0, 0, c! + 1);
      return [[">=", low], ["<", upper]];
    }
    case "~":
      return [[">=", low], ["<", n === 1 ? v(a! + 1) : v(a!, b! + 1)]];
    case ">=":
      return [[">=", low]];
    case ">":
      return n === 3 ? [[">", low]] : [[">=", next]];
    case "<":
      return [["<", low]];
    case "<=":
      return n === 3 ? [["<=", low]] : [["<", next]];
    default:
      return n === 3 ? [["=", low]] : [[">=", low], ["<", next]];
  }
}

/** A range as alternatives (`||`) of comparator sets (space-separated, all must hold), or null when it doesn't parse. */
export function parseRange(range: string): Comparator[][] | null {
  const sets: Comparator[][] = [];
  for (const alt of range.trim().split("||")) {
    // "1.2.3 - 2.3.4" (a hyphen range) is ">=1.2.3 <=2.3.4"
    const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(alt);
    const tokens = hyphen ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`] : alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/);
    const set: Comparator[] = [];
    for (const token of tokens) {
      const c = tokenComparators(token);
      if (!c) return null;
      set.push(...c);
    }
    sets.push(set);
  }
  return sets;
}

/** True if `version` is in `range` (npm's range syntax, ADR 0139), false if not, null if either doesn't parse. */
export function satisfies(version: string, range: string): boolean | null {
  const ver = parseVersion(version);
  const sets = parseRange(range);
  if (!ver || !sets) return null;
  const holds = ([op, bound]: Comparator) => {
    const d = compareVersions(ver, bound);
    return op === ">=" ? d >= 0 : op === ">" ? d > 0 : op === "<=" ? d <= 0 : op === "<" ? d < 0 : d === 0;
  };
  return sets.some((set) => set.every(holds));
}
