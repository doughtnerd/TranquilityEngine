// The command-line parser of the Node commands (ADR 0297): `myco-server` (main.ts) and
// `npm run export` (src/export/main.ts). One place for the flag rules: `--flag value` or
// `--flag=value`, `-h`/`--help`, unknown options, one positional argument, and what a missing value
// is; each command declares its options and keeps its own usage text.

/** Bad command-line arguments: the command prints the message and its usage, and exits 2. */
export class UsageError extends Error {}

/** One option: a switch, or one that takes a value (`takes` says what it is, for messages). */
export type CommandOption<O> =
  | { readonly takes: string; readonly set: (options: O, value: string, flag: string) => void }
  | { readonly takes?: undefined; readonly set: (options: O) => void };

export interface Command<O> {
  /** The options by flag (`--port`). `-h` and `--help` are every command's. */
  readonly options: Readonly<Record<string, CommandOption<O>>>;
  /** What the one positional argument is, for messages ("project folder"). */
  readonly argument: string;
  /** What the command does with it, for messages ("run"). */
  readonly verb: string;
}

/**
 * `argv` (without node and the script) as the command's options and its positional argument, or
 * `"help"`. Throws a `UsageError`. A value comes after its flag or after `=`; one that's missing,
 * empty, or (when it's the next argument) starts with `-` is refused.
 */
export function parseCommandLine<O extends object>(argv: readonly string[], command: Command<O>): { options: Partial<O>; argument: string } | "help" {
  const options: Partial<O> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const [flag, inline] = eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    if (flag === "-h" || flag === "--help") return "help";
    const option = Object.hasOwn(command.options, flag) ? command.options[flag] : undefined;
    if (!option) {
      if (arg.startsWith("-")) throw new UsageError(`Unknown option ${arg}.`);
      positional.push(arg);
    } else if (option.takes === undefined) {
      if (inline !== undefined) throw new UsageError(`${flag} takes no value.`);
      option.set(options as O);
    } else {
      const next = inline === undefined ? argv[i + 1] : undefined;
      const value = inline ?? (next !== undefined && !next.startsWith("-") ? (i++, next) : undefined);
      if (!value) throw new UsageError(`${flag} needs ${option.takes} (got ${value === "" ? '""' : "nothing"}).`);
      option.set(options as O, value, flag);
    }
  }
  if (positional.length === 0) throw new UsageError(`Give the ${command.argument} to ${command.verb}.`);
  if (positional.length > 1) throw new UsageError(`Give one ${command.argument} (got ${positional.map((p) => JSON.stringify(p)).join(", ")}).`);
  return { options, argument: positional[0] };
}

/**
 * Run a command's argument parsing: the parsed result, or the exit code once help (0) or a usage
 * error with the usage (2) is printed. `parse` throws `UsageError`s; other errors pass through.
 */
export function readCommandLine<T>(name: string, usage: string, parse: () => T | "help"): T | number {
  let result: T | "help";
  try {
    result = parse();
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${name}: ${err.message}\n\n${usage}`);
    return 2;
  }
  if (result === "help") {
    console.log(usage);
    return 0;
  }
  return result;
}
