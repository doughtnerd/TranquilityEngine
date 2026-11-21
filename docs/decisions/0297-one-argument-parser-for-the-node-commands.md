# 0297. One argument parser for the Node commands

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0033, 0035, 0041

## Context

Two Node commands take arguments: `myco-server` (`src/server/main.ts`, run by `src/server/cli.mjs`) and `npm run export` (`src/export/main.ts`, run by `src/export/cli.mjs`). Each had its own copy of the same loop: split `--flag=value`, `-h`/`--help`, refuse unknown options, collect one positional argument, its own `UsageError` class, and its own catch-print-usage-exit-2 block in `main`. The copies had already drifted on what a missing value is: export refused a missing value or one starting with `-` ("`--out needs a value.`"), while the server took the next argument whatever it was, so `--host --port 1` failed only because `--host` checked by hand and `--port` relied on the number check ("got nothing" vs "got \"--port\"").

## Decision

We will parse both commands' arguments with one small module, `src/server/commandLine.ts`:

- **`parseCommandLine(argv, command)`** returns `{ options, argument }` or `"help"`, throwing a `UsageError`. A command declares its options by flag, each a switch (`set(options)`) or one that takes a value (`takes`: what the value is, for messages; `set(options, value, flag)`, which may throw its own `UsageError` for a bad value), plus what its one positional argument is and the verb for messages ("Give the project folder to run.").
- **One missing-value rule:** a value comes after `=` (taken as given) or as the next argument; it is missing when absent, empty, or when the next argument starts with `-`. The message is uniform: `--port needs a port from 0 to 65535 (got nothing).` A switch given `=value` is refused.
- **`readCommandLine(name, usage, parse)`** prints the usage for help (exit 0) or after a usage error (`name: message`, then the usage; exit 2), and lets other errors through.
- Each command keeps its own flags, value checks (the server's number ranges, export's `--target` and `--build`/`--no-build` with desktop only), usage text and exported `parseArgs`. The `cli.mjs` launchers are unchanged.

## Alternatives considered

- **`node:util` `parseArgs`** — handles the splitting, but not our messages, the one-positional rule or value checks per option, and its strict mode errors are Node's wording; we would still wrap it per command.
- **An npm argument library (commander, yargs)** — a new dependency for two commands with a handful of flags each.
- **Leave the two copies** — the review rated this speculative (two callers); we took it because the missing-value rule had already drifted.

## Consequences

**Positive**
- One place for the flag rules; a third command declares its options and gets help, usage errors and exit codes.
- The two commands report missing values the same way.

**Negative / costs**
- Low leverage with two callers; a small module to know about.
- Message changes: export's `--out needs a value.` becomes `--out needs a folder (got nothing).`; a number flag followed by a negative number (`--port -1`) now reads as a missing value (`--port=-1` still reaches the range check).

## Deprecates

The two `UsageError` classes and hand-written loops in `src/server/main.ts` and `src/export/main.ts` (removed).

## Open questions

None.

## References

- `src/server/commandLine.ts`, `src/server/commandLine.test.ts`; `src/server/main.ts`, `src/export/main.ts`.
- Architecture review 2026-11-21, card 8.
