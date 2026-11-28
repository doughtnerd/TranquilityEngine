/** Page entry: exposes every spike test as `window.tests[name]()`; the runner (run.mjs) calls them one by one. */
import { t1aInstances, t1aNegative, t1aObjectLists, t1bThin } from "./test1";
import { t1cShadows } from "./test1c";
import { t3Shadows } from "./test3";
import { t4Fragment, t4Upload } from "./test4";
import { t2Complement, t2EffectCounts, t2PerInstance } from "./test2";

const tests: Record<string, () => Promise<unknown>> = {
  "1a-instances-setEnabled": () => t1aInstances("setEnabled"),
  "1a-instances-isVisible": () => t1aInstances("isVisible"),
  "1a-negative-enable-in-hook": () => t1aNegative(),
  "1a-alt-perViewObjectList": () => t1aObjectLists(),
  "1b-thin-updated": () => t1bThin("updated"),
  "1b-thin-setBuffer": () => t1bThin("setBuffer"),
  "1c-shadow-instances": () => t1cShadows({ kind: "instances" }),
  "1c-shadow-instances-hideBeforeFrame": () => t1cShadows({ kind: "instances", hideBeforeFrame: true }),
  "1c-shadow-thin-restore": () => t1cShadows({ kind: "thin", frames: 3 }),
  "1c-shadow-thin-noRestore-noHook": () => t1cShadows({ kind: "thin", restore: false, frames: 3 }),
  "1c-shadow-thin-noRestore-shadowHook": () => t1cShadows({ kind: "thin", restore: false, shadowHook: true, frames: 3 }),
  "1c-shadow-instances-csm": () => t1cShadows({ kind: "instances", cascaded: true }),
  "1c-shadow-instances-csm-perCamera": () => t1cShadows({ kind: "instances", cascaded: true, csmPerCamera: true }),
  "2-complement-instances": () => t2Complement("instances", false),
  "2-complement-instances-withOffsetPlugin": () => t2Complement("instances", true),
  "2-complement-thin": () => t2Complement("thin", false),
  "2-complement-thin-withOffsetPlugin": () => t2Complement("thin", true),
  "2-perInstance-instances": () => t2PerInstance("instances"),
  "2-perInstance-thin": () => t2PerInstance("thin"),
  "2-effectCounts": () => t2EffectCounts(),
  "3-shadows": () => t3Shadows(),
  "4-fragment": () => t4Fragment(),
  "4-upload": () => t4Upload(),
};
(window as unknown as { tests: typeof tests }).tests = tests;
(window as unknown as { ready: boolean }).ready = true;
