// How the live debugger reaches T51's canvases (ADR 0373 "Live debugger"; T52): a small context holding the frame's
// overlay (`overlayLogic.ts`). The graph editor provides it while it debugs a running Animator; `PoseCanvas` and
// `MachineCanvas` read it to draw weight bars, phases, the current state and each transition's blocker. Without a
// provider the value is null and the canvases draw as they always did.
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { GraphOverlay } from "./overlayLogic";

/** @internal The overlay the canvases draw (null: not debugging). */
export const LiveOverlay = createContext<GraphOverlay | null>(null);

/** @internal The overlay of the nearest provider, or null. */
export const useLiveOverlay = (): GraphOverlay | null => useContext(LiveOverlay);
