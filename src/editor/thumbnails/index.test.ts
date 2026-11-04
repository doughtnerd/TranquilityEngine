import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorProject } from "../projects";
import { currentProject } from "../state";
import { installThumbnails } from "./index";
import { ThumbnailService } from "./service";

describe("the open project's thumbnail service (ADR 0061)", () => {
  afterEach(() => {
    currentProject.value = null;
    vi.restoreAllMocks();
  });

  it("lets the service go (its URLs and caches) when the project closes", async () => {
    const dispose = vi.spyOn(ThumbnailService.prototype, "dispose");
    const stop = installThumbnails();
    try {
      const project = { files: [], canSave: false, root: null, fileSystem: null, assets: new Map(), textOf: () => undefined, sizeOf: () => undefined } as unknown as EditorProject;
      currentProject.value = project;
      expect(dispose).not.toHaveBeenCalled();
      currentProject.value = null; // Close Project
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });
});
