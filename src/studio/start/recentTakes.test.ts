import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../../editor/memoryFs";
import type { RecentProject } from "../../editor/recentProjects";
import { formatTakeLength, listRecentTakes, type TakeReader } from "./recentTakes";

const project = (id: string, path: string, kind: "path" | "handle" = "path"): RecentProject => ({ id, name: id, path, lastOpened: 1, kind });

/** A reader whose result comes from the file's text: "<seconds>@<ms>" (ms may be empty), or "bad" to fail. */
const read: TakeReader = async (b) => {
  const t = new TextDecoder().decode(b);
  if (t === "bad") throw new Error("corrupt");
  const [s, ms] = t.split("@");
  return { seconds: Number(s), recordedMs: ms === "" ? null : Number(ms) };
};

function rig() {
  const fs = new MemoryFileSystem();
  const put = (p: string, text: string) => void fs.files.set(p.replace(/\//g, "\\"), new TextEncoder().encode(text));
  return { fs, put };
}

describe("listRecentTakes", () => {
  it("walks takes/ recursively, skips notes and other files, and fills length and date", async () => {
    const { fs, put } = rig();
    put("C:/g/a/takes/one.mycotake", "10@1000");
    put("C:/g/a/takes/HoverBike/two.mycotake", "20@3000");
    put("C:/g/a/takes/HoverBike/two.mycotake.notes.json", "{}");
    put("C:/g/a/takes/readme.txt", "x");
    put("C:/g/a/other/three.mycotake", "5@9999");
    const out = await listRecentTakes([project("a", "C:/g/a")], fs, read);
    expect(out.map((t) => [t.name, t.path, t.seconds, t.recordedMs])).toEqual([
      ["two", "takes/HoverBike/two.mycotake", 20, 3000],
      ["one", "takes/one.mycotake", 10, 1000],
    ]);
    expect(out[0].project.id).toBe("a");
  });

  it("skips a project with no folder, and browser handle entries", async () => {
    const { fs, put } = rig();
    put("C:/g/b/takes/x.mycotake", "1@1");
    put("C:/g/h/takes/y.mycotake", "1@2");
    const out = await listRecentTakes([project("gone", "C:/g/gone"), project("h", "C:/g/h", "handle"), project("b", "C:/g/b")], fs, read);
    expect(out.map((t) => t.name)).toEqual(["x"]);
  });

  it("sorts newest first, unknown dates last, then by name", async () => {
    const { fs, put } = rig();
    put("C:/g/a/takes/zz.mycotake", "1@");
    put("C:/g/a/takes/aa.mycotake", "1@");
    put("C:/g/a/takes/old.mycotake", "1@100");
    put("C:/g/b/takes/new.mycotake", "1@200");
    const out = await listRecentTakes([project("a", "C:/g/a"), project("b", "C:/g/b")], fs, read);
    expect(out.map((t) => t.name)).toEqual(["new", "old", "aa", "zz"]);
  });

  it("reads at most `limit` takes", async () => {
    const { fs, put } = rig();
    for (let i = 0; i < 5; i++) put(`C:/g/a/takes/t${i}.mycotake`, `1@${i}`);
    expect(await listRecentTakes([project("a", "C:/g/a")], fs, read, 2)).toHaveLength(2);
    expect(await listRecentTakes([project("a", "C:/g/a")], fs, read)).toHaveLength(5);
  });

  it("keeps a take that fails to read, with null length and date", async () => {
    const { fs, put } = rig();
    put("C:/g/a/takes/ok.mycotake", "3@50");
    put("C:/g/a/takes/broken.mycotake", "bad");
    const out = await listRecentTakes([project("a", "C:/g/a")], fs, read);
    expect(out.map((t) => [t.name, t.seconds, t.recordedMs])).toEqual([["ok", 3, 50], ["broken", null, null]]);
  });
});

describe("formatTakeLength", () => {
  it("formats minutes, hours and unknown", () => {
    expect(formatTakeLength(42)).toBe("0:42");
    expect(formatTakeLength(76)).toBe("1:16");
    expect(formatTakeLength(723)).toBe("12:03");
    expect(formatTakeLength(3723)).toBe("1:02:03");
    expect(formatTakeLength(null)).toBe("—");
  });
});
