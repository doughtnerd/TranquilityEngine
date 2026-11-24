import { afterEach, describe, expect, it } from "vitest";
import { currentProject } from "../../editor/state";
import { openTakesFolder } from "../../editor/projects";
import { MemoryFileSystem, ROOT } from "../../editor/testing";
import { takesFolderChoice } from "../takesFolder";
import type { RouteRequest } from "./route";
import { goLive } from "./liveConnect";

function host() {
  const opened: string[] = [];
  const routes: RouteRequest[] = [];
  return { opened, routes, openTakes: async (root: string) => void opened.push(root), openRoute: (r: RouteRequest) => void routes.push(r) };
}

afterEach(() => {
  currentProject.value = null;
  takesFolderChoice.value = null;
});

describe("going live on a connected build (ADR 0408)", () => {
  it("with no project, opens the takes folder and the Profiler", async () => {
    takesFolderChoice.value = "D:/takes";
    const h = host();
    await goLive(h);
    expect(h.opened).toEqual(["D:/takes"]);
    expect(h.routes).toEqual([{ screen: "profiler" }]);
  });

  it("with a project open, keeps it and opens the Profiler", async () => {
    currentProject.value = await openTakesFolder(new MemoryFileSystem(), `${ROOT}/t`);
    takesFolderChoice.value = "D:/takes";
    const h = host();
    await goLive(h);
    expect(h.opened).toEqual([]);
    expect(h.routes).toEqual([{ screen: "profiler" }]);
  });

  it("in a browser (no takes folder), opens a live session kept in memory", async () => {
    const h = host();
    await goLive(h);
    expect(h.opened).toEqual(["C:/Live session"]);
    expect(h.routes).toEqual([{ screen: "profiler" }]);
  });
});
