// ADR 0157, api-and-models §5, task A0.10: every ported Chromium file keeps its BSD-3-Clause notice
// and pinned provenance, and the staged reference copies match PROVENANCE.md. Node built-ins only.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const audio = join(repo, "native", "audio");
const blink = join(audio, "third_party", "blink");
const portsPath = join(audio, "PORTS.md");
const provenancePath = join(blink, "PROVENANCE.md");
const hasAudio = existsSync(audio);

// The pinned Chromium commit: the first full hash in backticks in PORTS.md.
const pin = hasAudio ? (readFileSync(portsPath, "utf8").match(/`([0-9a-f]{40})`/)?.[1] ?? "") : "";

// The problems with one file's header, or none. A file is "ported" when it has a `// Ported from chromium` line.
function portedHeaderProblems(text: string, commit: string): string[] {
  const problems: string[] = [];
  const lines = text.split("\n");
  if (!lines.some((l) => /SPDX-License-Identifier:.*BSD-3-Clause/.test(l))) problems.push("no SPDX line naming BSD-3-Clause");
  if (!lines.some((l) => /Copyright.*Google/.test(l))) problems.push("no Chromium (Google) copyright line");
  const ported = lines.filter((l) => /^\s*\/\/ Ported from chromium\//.test(l));
  if (ported.length === 0) problems.push("no `// Ported from chromium/...` line");
  for (const line of ported) {
    if (!line.endsWith(`@ ${commit}`)) problems.push(`provenance line not pinned to ${commit}: ${line.trim()}`);
  }
  return problems;
}

// Every .rs file under dir that claims a port, with its header problems.
function scanPorted(dir: string, commit: string): string[] {
  return rsFiles(dir).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    if (!/^\/\/ Ported from chromium/m.test(text)) return [];
    return portedHeaderProblems(text, commit).map((p) => `${relative(repo, file).split("\\").join("/")}: ${p}`);
  });
}

function rsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "target" ? [] : rsFiles(path);
    return name.endsWith(".rs") ? [path] : [];
  });
}

// The module paths named in PORTS.md's table rows (backticked .rs or .ts paths).
function tableModules(ports: string): string[] {
  return ports
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .flatMap((l) => [...l.matchAll(/`([^`]+\.(?:rs|ts))`/g)].map((m) => m[1]));
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe.skipIf(!hasAudio)("ported Chromium files (real tree)", () => {
  it("every ported .rs file under native/audio/crates has the BSD-3-Clause header", () => {
    expect(scanPorted(join(audio, "crates"), pin)).toEqual([]);
  });

  it("every module named in PORTS.md that exists as a file carries the header", () => {
    const ports = readFileSync(portsPath, "utf8");
    const problems = tableModules(ports)
      .filter((p) => existsSync(join(repo, p)))
      .flatMap((p) => portedHeaderProblems(readFileSync(join(repo, p), "utf8"), pin).map((m) => `${p}: ${m}`));
    expect(problems).toEqual([]);
  });

  it("every staged file in third_party/blink is listed in PROVENANCE.md with its SHA-256", () => {
    const listed = new Map<string, string>();
    for (const line of readFileSync(provenancePath, "utf8").split("\n")) {
      const m = line.match(/^\|\s*`([^`]+)`\s*\|.*\|\s*`([0-9a-f]{64})`\s*\|\s*$/);
      if (m) listed.set(m[1], m[2]);
    }
    const staged = readdirSync(blink).filter((f) => f !== "PROVENANCE.md" && statSync(join(blink, f)).isFile());
    expect(staged.length).toBeGreaterThan(0);
    for (const name of staged) {
      expect(listed.get(name), name).toBe(sha256(join(blink, name)));
    }
  });
});

describe("the header check catches a missing or unpinned notice", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "myco-ports-"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "good.rs"), goodHeader(pin), "utf8");
    writeFileSync(join(dir, "sub", "bad.rs"), "// Ported from chromium/src/third_party/blink/renderer/platform/audio/biquad.cc @ " + pin + "\nfn main() {}\n", "utf8");
    writeFileSync(join(dir, "unpinned.rs"), goodHeader("0".repeat(40)), "utf8");
    writeFileSync(join(dir, "plain.rs"), "fn unported() {}\n", "utf8");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("flags a ported file without a notice, and one pinned to another commit, and ignores unported files", () => {
    const problems = scanPorted(dir, pin).map((p) => p.split(": ")[0].split(/[\\/]/).pop());
    expect(problems.sort()).toEqual(["bad.rs", "bad.rs", "unpinned.rs"]);
  });

  it("passes a file with the full header", () => {
    expect(portedHeaderProblems(goodHeader(pin), pin)).toEqual([]);
  });
});

function goodHeader(commit: string): string {
  return [
    "// SPDX-License-Identifier: BSD-3-Clause",
    `// Ported from chromium/src/third_party/blink/renderer/platform/audio/biquad.cc @ ${commit}`,
    "// Copyright (C) 2010 Google Inc. All rights reserved.",
    "//",
    "// Redistribution and use in source and binary forms, with or without",
    "fn ported() {}",
    "",
  ].join("\n");
}
