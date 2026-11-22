// The Spatial screen's panels (ADR 0333, 0327 "The shell", 0335; the prototype's layout, B.4): Scenes and Outline on the
// left, the Scene view in the middle (fixed), the Inspector and Scene settings on the right, Voices at the bottom, and
// History on demand. The panels read the screen's state (`spatialScreen.ts`) and call its actions; the Scene panel also
// owns what the screen does while it shows: following the route, the Scene view's keys, Space to play, and the player
// bar's slots (Play scene / Stop, "plays the scene from the active listener").
import { effect } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { currentProject, docVersion, status } from "../../../editor/state";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Panel } from "../../../editor/ui/panel/Panel";
import { applyAttenuationPreset } from "../../../engine/audio/attenuation/format";
import type { StudioPanel } from "../../shell/studioPanels";
import { audioHost, keymap, setPlayerSlots, studioRouter } from "../../shell/studioServices";
import { historyPanel } from "../placeholder";
import { attenuationSummary, ownedAttenuation, ownerText } from "./attenuationModel";
import { InspectorPanel } from "./InspectorPanel";
import { gameScenePaths } from "./newScene";
import { OutlinePanel } from "./OutlinePanel";
import type { SceneHost } from "./sceneHost";
import { SCENE_KEYS, type SceneAction } from "./sceneKeys";
import { ScenesPanel } from "./ScenesPanel";
import { SceneView } from "./SceneView";
import { setHidden, setLocked } from "./sceneEdits";
import { SettingsPanel } from "./SettingsPanel";
import { AttenuationChoiceDialog, GameSceneDialog, TakeDialog } from "./SpatialDialogs";
import {
  applyFolderChanges, applyRolloff, attenuationChoice, audition, auditionStatus, chooseAttenuation, copySelection, deleteScenes, deleteSelected, duplicateScene, duplicateSelection, editAttenuation, editMix, editScene, endDrag,
  ensureSceneKind, escapeKey, extraFolders, fit, followRoute, hover, listenHere, mix, mixDoc, materials, mute, newDialog, newFromGameScene, newFromTake, newScene, openDoc, openPath, openPlaylist, openScene, openTake, ownerOf, pasteClipboard,
  placeAt, playAllFrom, playing, playScene, readOnly, renameScene, renaming, scene, sceneEntries, selected, sideView, silenced, slab, solo, soundItems, stopAudition, togglePlay, tools, busNames, view, viewportSize, voices,
} from "./spatialScreen";
import { sceneName } from "./sceneTree";
import { viewKey } from "./viewTransform";
import { voiceTable } from "./voicesTable";
import { VoicesPanel } from "./VoicesPanel";
import "../playlists/playlists.css";
import "./spatial.css";

const writable = () => !!currentProject.value?.canSave;

function ScenesListPanel() {
  void docVersion.value;
  return (
    <Panel bodyClass="sp-panel-body">
      <ScenesPanel
        entries={sceneEntries.value}
        openPath={openPath.value}
        writable={writable()}
        hasOpen={!!scene.value}
        extra={extraFolders.value}
        setExtra={(f) => (extraFolders.value = f)}
        actions={{
          open: openScene,
          newScene,
          rename: (path, name) => void renameScene(path, name),
          duplicate: (path) => void duplicateScene(path),
          remove: (paths) => void deleteScenes(paths),
          setFolders: applyFolderChanges,
          refuse: (label, why) => (status.value = { kind: "info", text: `Can't ${label.toLowerCase()}: ${why}.` }),
        }}
      />
      {newDialog.value?.kind === "game" && (
        <GameSceneDialog scenes={gameScenePaths(currentProject.value?.files ?? [])} onCancel={() => (newDialog.value = null)} onPick={(p) => newFromGameScene(p, newDialog.peek()?.folder ?? "")} />
      )}
      {newDialog.value?.kind === "take" && (
        <TakeDialog
          takes={(currentProject.value?.files ?? []).filter((f) => f.toLowerCase().endsWith(".mycotake"))}
          open={async (p) => {
            const t = await openTake(p);
            const folder = newDialog.peek()?.folder ?? "";
            return { duration: t.duration, at: (time) => t.at(time, folder) };
          }}
          onCreate={newFromTake}
          onCancel={() => (newDialog.value = null)}
        />
      )}
    </Panel>
  );
}

/** The Scene view's host over the screen's signals. */
function sceneHost(): SceneHost | null {
  const s = scene.value;
  const path = openPath.value;
  if (!s || !path) return null;
  return {
    scene: s,
    path,
    readOnly: readOnly.value,
    selected: selected.value,
    select: (id) => (selected.value = id),
    tools: tools.value,
    setTools: (t) => (tools.value = t),
    view: view.value,
    setView: (v) => (view.value = v),
    setSize: (sz) => {
      const first = viewportSize.peek().width === 800 && viewportSize.peek().height === 600;
      viewportSize.value = sz;
      if (first) fit();
    },
    fit,
    slab: slab.value,
    setSlab: (x) => (slab.value = x),
    sideView: sideView.value,
    setSideView: (on) => (sideView.value = on),
    hover: hover.value,
    setHover: (id) => (hover.value = id),
    renaming: renaming.value,
    setRenaming: (id) => (renaming.value = id),
    playing: playing.value,
    voices: voices.value,
    silenced: (id) => silenced(id),
    solo: audition.value.solo,
    edit: editScene,
    endDrag,
    place: placeAt,
    remove: (id) => void deleteSelected(id),
    soloToggle: solo,
    muteToggle: mute,
    editAttenuation: (id) => editAttenuation(id),
    playAll: playAllFrom,
    listenHere,
  };
}

function runSceneAction(a: SceneAction): boolean | void {
  if (!scene.peek()) return false;
  switch (a.kind) {
    case "copy":
      return copySelection();
    case "paste":
      return !readOnly.peek() && pasteClipboard();
    case "duplicate":
      return !readOnly.peek() && duplicateSelection();
    case "delete":
      return !readOnly.peek() && deleteSelected();
    case "view":
      view.value = viewKey(view.peek(), viewportSize.peek(), a.key, a.big);
      return;
    case "reset":
      return fit();
    case "escape":
      return escapeKey();
  }
}

/** What the screen does while it shows: the route, the keys, the player bar. */
function useScreen(): void {
  useEffect(() => {
    ensureSceneKind();
    const stops = [
      followRoute(studioRouter().route),
      ...SCENE_KEYS.map((k) => keymap.register({ id: k.id, keys: k.keys, label: k.label, group: "Scene view", scope: { panel: "spatial-scene" }, run: () => runSceneAction(k.action) })),
      keymap.register({ id: "spatial.play", keys: ["Space"], label: "Play / stop the scene", scope: { screen: "spatial" }, run: () => (scene.peek() ? togglePlay() : false) }),
      effect(() => {
        const s = scene.value;
        const path = openPath.value;
        const on = playing.value;
        const state = audioHost().state.value;
        if (!s || !path) return setPlayerSlots("spatial", null);
        const blocked = state.kind === "failed" ? state.reason : state.kind === "idle" ? "The audio runtime isn't running." : null;
        setPlayerSlots("spatial", {
          nowPlaying: { art: "3D", title: sceneName(path), subtitle: "Test scene · plays the scene from the active listener" },
          transport: (
            <button type="button" class="sp-transport" aria-label={on ? "Stop" : "Play scene"} title={blocked ?? (on ? "Stop (Space)" : "Play the scene from the active listener (Space)")} disabled={!on && !!blocked} onClick={togglePlay}>
              {on ? "■ Stop" : "▶ Play scene"}
            </button>
          ),
          status: auditionStatus() ?? (blocked ? undefined : "Plays the scene from the active listener"),
        });
      }),
    ];
    return () => {
      for (const stop of stops) stop();
      stopAudition();
      setPlayerSlots("spatial", null);
    };
  }, []);
}

function ScenePanel() {
  useScreen();
  void docVersion.value;
  const host = sceneHost();
  if (!host) {
    return (
      <Panel bodyClass="sp-panel-body">
        <EmptyState
          title="Spatial"
          icon="◎"
          body={<p>Test scenes place emitters, listeners, obstacles and zones to hear how distance, occlusion, reverb zones and Doppler sound, through the engine's own spatial audio. Pick one in the Scenes panel, or make one.</p>}
          action={{ label: "New test scene", disabled: !writable(), run: () => newScene("blank", "") }}
        />
      </Panel>
    );
  }
  return (
    <Panel bodyClass="sp-panel-body">
      <SceneView host={host} />
      {attenuationChoice.value && <AttenuationChoiceDialog playlist={attenuationChoice.value.playlist} onCancel={() => (attenuationChoice.value = null)} onChoose={(how) => void chooseAttenuation(how)} />}
    </Panel>
  );
}

function OutlineListPanel() {
  void docVersion.value;
  const s = scene.value;
  if (!s) return <Panel bodyClass="sp-panel-body"><EmptyState compact title="No scene open" body="The open scene's objects, by kind." /></Panel>;
  return (
    <Panel bodyClass="sp-panel-body">
      <div class="sp-doc" data-asset-document={openDoc.value?.path} tabIndex={-1}>
        <OutlinePanel
          scene={s}
          selected={selected.value}
          readOnly={readOnly.value}
          onSelect={(id) => (selected.value = id)}
          onHidden={(id, h) => editScene(h ? "Hide" : "Show", (x) => setHidden(x, id, h))}
          onLocked={(id, l) => editScene(l ? "Lock" : "Unlock", (x) => setLocked(x, id, l))}
          onHover={(id) => (hover.value = id)}
        />
      </div>
    </Panel>
  );
}

function InspectorListPanel() {
  void docVersion.value;
  const s = scene.value;
  if (!s) return <Panel bodyClass="sp-panel-body"><EmptyState compact title="Nothing selected" body="The selected object's sound, place, shape and height." /></Panel>;
  const sel = selected.value;
  const owner = sel ? ownerOf(sel) : null;
  const att = owner ? ownedAttenuation(owner) : null;
  return (
    <Panel bodyClass="sp-panel-body">
      <div class="sp-doc" data-asset-document={openDoc.value?.path} tabIndex={-1}>
        <InspectorPanel
          scene={s}
          selected={sel}
          readOnly={readOnly.value}
          voices={voices.value}
          playing={playing.value}
          buses={busNames.value}
          materials={materials.value.map((m) => m.name)}
          attenuation={owner ? { summary: att ? attenuationSummary(att) : null, owner: ownerText(owner), editable: owner.kind === "preset" ? !!owner.attenuation : owner.kind === "inline" || owner.kind === "none", rolloff: !!att && !readOnly.value } : null}
          solo={audition.value.solo}
          silenced={silenced}
          sounds={soundItems}
          onEdit={editScene}
          onEndDrag={endDrag}
          onSolo={solo}
          onMute={mute}
          onEditAttenuation={(id) => editAttenuation(id)}
          onRolloff={(id, preset) => applyRolloff(id, (a) => applyAttenuationPreset(a, preset))}
          onListenHere={listenHere}
          onEditPath={(id) => (tools.value = { tool: "select", pathEdit: id })}
          onDelete={(id) => void deleteSelected(id)}
          onOpenSound={openPlaylist}
        />
      </div>
    </Panel>
  );
}

function SettingsListPanel() {
  void docVersion.value;
  const m = mix.value;
  if (!m) return <Panel bodyClass="sp-panel-body"><EmptyState compact title="No project open" body="The project's spatial settings." /></Panel>;
  return (
    <Panel bodyClass="sp-panel-body">
      <div class="sp-doc" data-asset-document={mixDoc.value?.path} tabIndex={-1}>
        <SettingsPanel mix={m} readOnly={!writable() || !!mixDoc.value?.readOnly} onEdit={editMix} onEndDrag={() => void mixDoc.peek()?.flush()} />
      </div>
    </Panel>
  );
}

function VoicesListPanel() {
  const s = scene.value;
  const state = audioHost().state.value;
  const blocked = !s ? "Open a test scene to play it." : state.kind === "failed" ? state.reason : state.kind === "idle" ? "The audio runtime isn't running." : undefined;
  return (
    <Panel bodyClass="sp-panel-body">
      <VoicesTable blocked={blocked} />
    </Panel>
  );
}

function VoicesTable(props: { blocked?: string }) {
  const s = scene.value;
  const rows = s ? voiceTable(s, voices.value, silenced) : [];
  return <VoicesPanel rows={rows} playing={playing.value} blocked={props.blocked} selected={selected.value} onSelect={(id) => (selected.value = id)} onPlay={playScene} />;
}

/** The screen's panels, in the prototype's places. */
export const SPATIAL_PANELS: readonly StudioPanel[] = [
  { id: "spatial-scenes", title: "Scenes", dock: "left", view: () => <ScenesListPanel /> },
  { id: "spatial-outline", title: "Outline", dock: "left", view: () => <OutlineListPanel /> },
  { id: "spatial-scene", title: "Scene", dock: "fill", fixed: true, view: () => <ScenePanel /> },
  { id: "spatial-inspector", title: "Inspector", dock: "right", view: () => <InspectorListPanel /> },
  { id: "spatial-settings", title: "Scene settings", dock: "right", view: () => <SettingsListPanel /> },
  { id: "spatial-voices", title: "Voices", dock: "bottom", view: () => <VoicesListPanel /> },
  historyPanel("spatial"),
];
