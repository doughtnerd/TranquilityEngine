import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCommandLine, readCommandLine, UsageError, type Command } from "./commandLine";
import { USAGE as SERVER_USAGE, main as serverMain, parseArgs as serverArgs } from "./main";
import { USAGE as EXPORT_USAGE, main as exportMain, parseArgs as exportArgs } from "../export/main";

// The Node commands' argument parser (ADR 0297), and each command's argument handling through it.

interface Opts {
  name: string;
  count: number;
  loud: boolean;
}
const COMMAND: Command<Opts> = {
  argument: "thing",
  verb: "greet",
  options: {
    "--name": { takes: "a name", set: (o, v) => void (o.name = v) },
    "--count": {
      takes: "a count",
      set: (o, v, flag) => {
        if (!/^\d+$/.test(v)) throw new UsageError(`${flag} needs a count (got ${JSON.stringify(v)}).`);
        o.count = Number(v);
      },
    },
    "--loud": { set: (o) => void (o.loud = true) },
  },
};
const parse = (argv: string[]) => parseCommandLine(argv, COMMAND);

afterEach(() => vi.restoreAllMocks());

describe("parseCommandLine", () => {
  it("takes values after the flag or after =, switches, and the one positional argument anywhere", () => {
    expect(parse(["a", "--name", "Ann", "--count=3", "--loud"])).toEqual({ argument: "a", options: { name: "Ann", count: 3, loud: true } });
    expect(parse(["--name=x=y", "a"])).toEqual({ argument: "a", options: { name: "x=y" } });
    expect(parse(["--name=-dash", "a"])).toEqual({ argument: "a", options: { name: "-dash" } }); // after = a value is taken as given
  });

  it("answers help for -h or --help, read left to right", () => {
    expect(parse(["-h"])).toBe("help");
    expect(parse(["a", "b", "--name", "x", "--help"])).toBe("help"); // before the positional check
    expect(parse(["--loud", "--help"])).toBe("help");
  });

  it("refuses a missing or empty value the same way for every option, and an option's own bad value its way", () => {
    expect(() => parse(["a", "--name"])).toThrow("--name needs a name (got nothing).");
    expect(() => parse(["a", "--name", "--loud"])).toThrow("--name needs a name (got nothing).");
    expect(() => parse(["a", "--name="])).toThrow('--name needs a name (got "").');
    expect(() => parse(["a", "--count", "x"])).toThrow('--count needs a count (got "x").');
    expect(() => parse(["a", "--loud=yes"])).toThrow("--loud takes no value.");
  });

  it("refuses unknown options and anything but one positional argument", () => {
    expect(() => parse(["a", "--bogus"])).toThrow("Unknown option --bogus.");
    expect(() => parse(["a", "-x"])).toThrow("Unknown option -x.");
    expect(() => parse(["a", "--toString"])).toThrow("Unknown option --toString."); // not an inherited property
    expect(() => parse([])).toThrow("Give the thing to greet.");
    expect(() => parse(["a", "b"])).toThrow('Give one thing (got "a", "b").');
    expect(() => parse(["a"])).not.toThrow();
  });
});

describe("readCommandLine", () => {
  it("prints the usage for help (0) or after a usage error (2), and passes other errors through", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readCommandLine("cmd", "Usage: cmd", () => "help")).toBe(0);
    expect(log).toHaveBeenCalledWith("Usage: cmd");
    expect(readCommandLine("cmd", "Usage: cmd", () => parse([]))).toBe(2);
    expect(error).toHaveBeenCalledWith("cmd: Give the thing to greet.\n\nUsage: cmd");
    expect(readCommandLine("cmd", "Usage: cmd", () => ({ ok: true }))).toEqual({ ok: true });
    expect(() => readCommandLine("cmd", "", () => { throw new TypeError("bug"); })).toThrow("bug");
  });
});

describe("the commands' argument handling", () => {
  it("myco-server: its flags, numbers checked, and the shared rules", () => {
    expect(serverArgs(["proj", "--port", "0", "--stats-interval=1.5", "--host", "::1"])).toEqual({ projectDir: "proj", port: 0, statsIntervalMs: 1500, host: "::1" });
    expect(() => serverArgs(["proj", "--tick-rate", "0"])).toThrow('--tick-rate needs a number of steps per second, above 0 and at most 1000 (got "0").');
    expect(() => serverArgs(["proj", "--max-connections=1.5"])).toThrow(/--max-connections needs a whole number/);
    expect(() => serverArgs(["proj", "--port"])).toThrow("--port needs a port from 0 to 65535 (got nothing).");
    expect(() => serverArgs(["proj", "--host", "--port", "1"])).toThrow("--host needs a host name or address (got nothing).");
    expect(() => serverArgs(["a", "b"])).toThrow(/Give one project folder/);
  });

  it("export: its flags, the desktop-only switches, and the shared rules", () => {
    expect(exportArgs(["proj", "--out=../web", "--scene", ".\\scenes\\a.scene.json"])).toEqual({ projectDir: "proj", out: "../web", mainScene: "scenes/a.scene.json" });
    expect(exportArgs(["proj", "--target", "desktop", "--build"])).toEqual({ projectDir: "proj", target: "desktop", tauriBuild: true });
    expect(() => exportArgs(["proj", "--target", "ios"])).toThrow('--target is web or desktop (got "ios").');
    expect(() => exportArgs(["proj", "--no-build"])).toThrow("--build and --no-build go with --target desktop.");
    expect(() => exportArgs(["proj", "--out"])).toThrow("--out needs a folder (got nothing).");
    expect(() => exportArgs([])).toThrow("Give the project folder to export.");
  });

  it("each main prints its own usage: help exits 0, bad arguments 2", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await serverMain(["--help"])).toBe(0);
    expect(log).toHaveBeenLastCalledWith(SERVER_USAGE);
    expect(await serverMain(["proj", "--bogus"])).toBe(2);
    expect(error).toHaveBeenLastCalledWith(`myco-server: Unknown option --bogus.\n\n${SERVER_USAGE}`);
    expect(await exportMain(["-h"])).toBe(0);
    expect(log).toHaveBeenLastCalledWith(EXPORT_USAGE);
    expect(await exportMain(["proj", "--scene"])).toBe(2);
    expect(error).toHaveBeenLastCalledWith(`export: --scene needs a scene path (got nothing).\n\n${EXPORT_USAGE}`);
  });
});
