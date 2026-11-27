// The Camera Shake Inspector sections (ADR 0435 "Editor"), under a ShakeImpulseSource's and a CameraShake's fields:
// the source's preset envelope as a small plot labelled with its duration, the camera's noise profile in one line,
// and on both a Test button that, while the game plays, fires the selected node's impulse (`generateImpulse()`) or
// shakes its camera (`shake("bump")`) in the running game. Nothing is saved: it acts on the play session's live node,
// found as the Ragdoll builder's Test Drop finds it (the scene-file id among the play Worlds' nodes, ADR 0232).
import type { Component } from "../../../engine/core/Component";
import type { World } from "../../../engine/core/World";
import { listNodes } from "../../../engine/editor";
import { editor, sectionField, type InspectorSectionProps } from "../../../editor/sdk";
import { CameraShake } from "../runtime/CameraShake";
import { ShakeImpulseSource } from "../runtime/ShakeImpulseSource";
import { envelopePoints, formatSeconds, impulseDuration, impulsePresetOf, noiseSummary } from "./shakeSectionLogic";
import "./cameraShake.css";

const PLOT_W = 160;
const PLOT_H = 36;

/** The `index`th `type` component of the selected node (scene-file id `id`) in the play session, with its World; null when not playing or not unique. */
function liveComponent<T extends Component>(type: abstract new () => T, id: string, index: number): { world: World; component: T } | null {
  for (const world of editor.scene.playWorlds) {
    const found = listNodes(world).filter((n) => n.id === id);
    if (found.length !== 1) continue;
    const component = found[0]!.node.getComponents(type)[index];
    if (component) return { world, component };
  }
  return null;
}

/** The Test button's state: off until the game plays and the node is in it. */
function testState(live: boolean, what: string): { disabled: boolean; title: string } {
  if (editor.scene.playState !== "playing") return { disabled: true, title: `Press Play first: Test ${what} in the running game (nothing is saved).` };
  if (!live) return { disabled: true, title: "The selected node isn't in the running game's scene." };
  return { disabled: false, title: `${what.charAt(0).toUpperCase()}${what.slice(1)} in the running game now.` };
}

function TestButton(props: { live: boolean; what: string; onTest(): void }) {
  const s = testState(props.live, props.what);
  return (
    <button type="button" class="camera-shake-test" disabled={s.disabled} title={s.title} onClick={props.onTest}>
      Test
    </button>
  );
}

/** Under a ShakeImpulseSource: its preset's envelope and a Test button that sends one impulse. */
export function ImpulseSourceSection({ paths, info }: InspectorSectionProps) {
  const path = paths[0]!;
  const preset = impulsePresetOf(sectionField(info, "preset"));
  const live = liveComponent(ShakeImpulseSource, path[path.length - 1]!, info.index);
  const fire = () => {
    if (live) live.component.generateImpulse(); // into the source's own World
  };
  return (
    <div class="camera-shake-section">
      {preset && (
        <figure class="camera-shake-envelope">
          <figcaption title="The impulse's strength over its duration (the preset's envelope)">
            {preset} envelope, {formatSeconds(impulseDuration(preset, sectionField(info, "duration")))}
          </figcaption>
          <svg viewBox={`-1 -1 ${PLOT_W + 2} ${PLOT_H + 2}`} width={PLOT_W} height={PLOT_H} role="img" aria-label={`${preset} envelope`}>
            <line class="camera-shake-axis" x1={0} y1={PLOT_H} x2={PLOT_W} y2={PLOT_H} />
            <polyline class="camera-shake-curve" points={envelopePoints(preset, PLOT_W, PLOT_H)} />
          </svg>
        </figure>
      )}
      <div class="camera-shake-actions">
        <TestButton live={live !== null} what="send one impulse from this source" onTest={fire} />
      </div>
    </div>
  );
}

/** Under a CameraShake: its noise profile in a line and a Test button that shakes this camera with a bump. */
export function CameraShakeSection({ paths, info }: InspectorSectionProps) {
  const path = paths[0]!;
  const summary = noiseSummary(sectionField(info, "noise"));
  const live = liveComponent(CameraShake, path[path.length - 1]!, info.index);
  return (
    <div class="camera-shake-section">
      {summary && <p class="camera-shake-note" title="The continuous noise preset's octaves, at gain 1">Noise: {summary}</p>}
      <div class="camera-shake-actions">
        <TestButton live={live !== null} what="shake this camera with a bump" onTest={() => live?.component.shake("bump")} />
      </div>
    </div>
  );
}
