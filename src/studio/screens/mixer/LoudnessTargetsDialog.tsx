// Project settings · Loudness targets (UI pass MX-63, ADR 0171 decision 4 / ADR 0362 item 8): the project's own list,
// saved in `audio.json`. One row per target (default radio, name, integrated LUFS, tolerance LU, true-peak dBTP,
// remove), Add target and Defaults. Each change is one undo step of the mix document through `commit`.
import type { AudioProject } from "../../../engine/audio/project/types";
import { LOUDNESS_TARGET_LIMITS, MAX_LOUDNESS_TARGETS } from "../../../engine/audio/settings";
import { KitDialog } from "../../../editor/ui/KitDialog";
import type { EditResult } from "../../../editor/sdk/editResult";
import { Icon } from "../../components/Icon";
import { NumberField } from "../../components/NumberField";
import { addTarget, editTarget, makeDefaultTarget, removeTarget, resetTargets } from "./loudnessTargetsModel";

export interface LoudnessTargetsDialogProps {
  readonly project: AudioProject;
  readonly readOnly: boolean;
  commit(result: EditResult<AudioProject>, label: string): boolean;
  onClose(): void;
}

export function LoudnessTargetsDialog(props: LoudnessTargetsDialogProps) {
  const { project: p, readOnly: ro, commit } = props;
  const targets = p.loudness.targets;
  return (
    <KitDialog title="Project settings · Loudness targets" width={620} class="mx-targets-dialog" onClose={props.onClose}
      summary={`${targets.length} of ${MAX_LOUDNESS_TARGETS} · saved in audio.json · the first is the default`}
      buttons={
        <>
          <button type="button" disabled={ro} title="Console −24, PC/web −18, mobile −16 LUFS, each ±2 LU with a −1 dBTP ceiling" onClick={() => commit(resetTargets(p), "Default loudness targets")}>Defaults</button>
          <button type="button" class="primary" onClick={props.onClose}>Done</button>
        </>
      }>
      <table class="mx-targets">
        <thead>
          <tr>
            <th scope="col" title="The target the meters check against first">Default</th>
            <th scope="col">Name</th>
            <th scope="col" title="Integrated loudness, LUFS">Integrated</th>
            <th scope="col" title="How far the integrated reading may be from the target, LU">Tolerance</th>
            <th scope="col" title="The true-peak ceiling, dBTP">True peak</th>
            <th scope="col"><span class="mx-sr">Remove</span></th>
          </tr>
        </thead>
        <tbody>
          {targets.map((t, i) => (
            <tr key={`${i}:${t.name}`}>
              <td><input type="radio" name="mx-default-target" aria-label={`${t.name} is the default`} checked={i === 0} disabled={ro} onChange={() => commit(makeDefaultTarget(p, i), "Default loudness target")} /></td>
              <td>
                <input class="mx-target-name" aria-label="Target name" value={t.name} disabled={ro}
                  onChange={(e) => { const el = e.currentTarget as HTMLInputElement; if (!commit(editTarget(p, i, { name: el.value }), "Rename loudness target")) el.value = t.name; }} />
              </td>
              <td><NumberField label={`${t.name} integrated`} hideLabel value={t.integrated} min={LOUDNESS_TARGET_LIMITS.integrated[0]} max={LOUDNESS_TARGET_LIMITS.integrated[1]} step={0.5} digits={1} unit="LUFS" size="narrow" disabled={ro} onValue={(v) => commit(editTarget(p, i, { integrated: v }), "Loudness target level")} /></td>
              <td><NumberField label={`${t.name} tolerance`} hideLabel value={t.tolerance} min={LOUDNESS_TARGET_LIMITS.tolerance[0]} max={LOUDNESS_TARGET_LIMITS.tolerance[1]} step={0.5} digits={1} unit="LU" size="narrow" disabled={ro} onValue={(v) => commit(editTarget(p, i, { tolerance: v }), "Loudness target tolerance")} /></td>
              <td><NumberField label={`${t.name} true peak`} hideLabel value={t.truePeak} min={LOUDNESS_TARGET_LIMITS.truePeak[0]} max={LOUDNESS_TARGET_LIMITS.truePeak[1]} step={0.5} digits={1} unit="dBTP" size="narrow" disabled={ro} onValue={(v) => commit(editTarget(p, i, { truePeak: v }), "Loudness target ceiling")} /></td>
              <td>
                <button type="button" class="studio-icon-button" aria-label={`Remove ${t.name}`} title={targets.length <= 1 ? "A project keeps at least one target" : `Remove ${t.name}`} disabled={ro || targets.length <= 1} onClick={() => commit(removeTarget(p, i), "Remove loudness target")}>
                  <Icon name="close" size={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" class="mx-target-add" disabled={ro || targets.length >= MAX_LOUDNESS_TARGETS} onClick={() => commit(addTarget(p), "Add loudness target")}>
        <Icon name="plus" size={14} /> Target
      </button>
    </KitDialog>
  );
}
