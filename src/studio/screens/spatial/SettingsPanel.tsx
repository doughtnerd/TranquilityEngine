// The Scene settings panel (ADR 0347 "Settings the Spatial screen shows are the project's"; the prototype's scene settings,
// B.4, spec §4.4.7): `audio.json`'s Listening (HRTF for the nearest N voices and the ambisonic bed distance, each a
// slider with its typed field), Doppler amount, and Occlusion: the spec's summary (rays per voice, what a fully blocked
// path sounds like, the physics layers rays hit, the occlusion curves) on top of ADR 0347's per-material table. Each
// change is one undo step of the mix document (the Mixer's, so the Mixer's history shows it too). Explanations are
// tooltips (spec §1.3).
import type { AudioProject } from "../../../engine/audio/project/types";
import { MATERIAL_LIMITS } from "../../../engine/audio/occlusionMaterials";
import { FieldRow, NumberBox, Section } from "../../../editor/ui/PanelFields";
import { Icon } from "../../components/Icon";
import { FIELDS } from "./inspectorFields";
import { addMaterial, dopplerPercent, editMaterial, isBuiltinMaterial, materialText, removeMaterial, setBedBeyond, setDefaultMaterial, setDopplerPercent, setHrtfVoices } from "./settingsEdits";
import type { EditResult } from "./sceneEdits";

export interface SettingsPanelProps {
  readonly mix: AudioProject;
  readonly readOnly: boolean;
  onEdit(label: string, edit: (p: AudioProject) => EditResult<AudioProject>, drag?: boolean): boolean;
  onEndDrag(): void;
}

/** The HRTF slider's range (the prototype's 1–6); the field takes the format's whole range. */
const HRTF_SLIDER: readonly [number, number] = [1, 6];
/** Rays the occlusion pass casts per voice (the runtime's: one; the nearest few get more on the high preset). */
const RAYS_TEXT = "1";
const RAYS_TIP = "One ray per voice; on the high quality preset the nearest 4 get 3 rays each";

export function SettingsPanel(props: SettingsPanelProps) {
  const { mix, readOnly: ro, onEdit } = props;
  const s = mix.settings;
  const occ = s.occlusion;
  const layers = occ.layers === null ? "every layer" : occ.layers.length === 0 ? "none (occlusion is off)" : occ.layers.join(", ");
  const def = occ.materials.find((m) => m.name === occ.defaultMaterial);
  const bed = s.bedBeyond;
  const [bLo, bHi] = FIELDS.bedBeyond.slider;
  return (
    <div class="sp-settings" title="The project's settings (audio.json): they apply to the game as well as these scenes.">
      <Section title="Listening">
        <FieldRow label={FIELDS.hrtf.label} unit="voices" title="The nearest voices get HRTF (rendered around your head); the rest are panned">
          <input type="range" class="sp-range" aria-label="HRTF voices slider" min={HRTF_SLIDER[0]} max={HRTF_SLIDER[1]} step={1} value={Math.min(HRTF_SLIDER[1], Math.max(HRTF_SLIDER[0], s.voices.hrtf))} disabled={ro}
            onInput={(e) => onEdit("HRTF voice count", (p) => setHrtfVoices(p, Number((e.currentTarget as HTMLInputElement).value)), true)} onChange={props.onEndDrag} />
          <NumberBox label="HRTF voices" value={s.voices.hrtf} min={FIELDS.hrtf.min} max={FIELDS.hrtf.max} step={1} digits={0} disabled={ro} onValue={(v) => onEdit("HRTF voice count", (p) => setHrtfVoices(p, v))} />
        </FieldRow>
        <FieldRow label={FIELDS.bedBeyond.label} unit="m" title="Far sounds fold into one ambisonic bed, which is cheap; near ones get full HRTF. Off: beds by priority only">
          <input type="checkbox" class="sp-bed-on" aria-label="Fold far sounds into the bed" title={bed === null ? "Off: beds by priority only. Turn on to fold far sounds into the bed" : "Turn off: beds by priority only"} checked={bed !== null} disabled={ro}
            onChange={(e) => onEdit("Ambisonic bed distance", (p) => setBedBeyond(p, (e.currentTarget as HTMLInputElement).checked ? 45 : null))} />
          <input type="range" class="sp-range" aria-label="Bed distance slider" min={bLo} max={bHi} step={1} value={Math.min(bHi, Math.max(bLo, bed ?? 45))} disabled={ro || bed === null}
            onInput={(e) => onEdit("Ambisonic bed distance", (p) => setBedBeyond(p, Number((e.currentTarget as HTMLInputElement).value)), true)} onChange={props.onEndDrag} />
          {bed !== null ? (
            <NumberBox label="Bed distance" value={bed} min={FIELDS.bedBeyond.min} max={FIELDS.bedBeyond.max} step={1} digits={0} disabled={ro} onValue={(v) => onEdit("Ambisonic bed distance", (p) => setBedBeyond(p, v))} />
          ) : (
            <span class="sp-faint sp-off">Off</span>
          )}
        </FieldRow>
      </Section>
      <Section title="Occlusion" hint="Obstacles block sound with their material: losses of several on one ray add up. Rays hit colliders on the physics layers below.">
        <dl class="sp-kv">
          <dt title={RAYS_TIP}>Rays per voice</dt>
          <dd>{RAYS_TEXT}</dd>
          <dt title={`Through one obstacle of the default material (${occ.defaultMaterial})`}>Fully blocked</dt>
          <dd>{def ? materialText(def) : "—"}</dd>
          <dt>Uses</dt>
          <dd>Physics layer: {layers}</dd>
          <dt>Curves</dt>
          <dd>
            <button type="button" class="sp-occb" disabled title="Occlusion curves (volume and low-pass by how blocked the path is) need the engine to read them; until then each material's loss and low-pass below are what a blocked path does (ADR 0347)">
              <Icon name="automate" size={12} /> Volume, low-pass
            </button>
          </dd>
        </dl>
        <div class="sp-mat-head">
          <span class="sp-cap">Materials</span>
          <button type="button" class="sp-small" disabled={ro} onClick={() => onEdit("Add material", (p) => { const r = addMaterial(p); return "refused" in r ? r : { next: r.next.project }; })}><Icon name="plus" size={14} /> Material</button>
        </div>
        <div class="sp-table-scroll">
        <table class="sp-materials">
          <colgroup><col class="sp-mat-default" /><col /><col class="sp-mat-num" /><col class="sp-mat-hz" /><col class="sp-mat-num" /><col class="sp-mat-remove" /></colgroup>
          <thead>
            <tr><th scope="col" title="The material obstacles use when they name none">Default</th><th scope="col">Material</th><th scope="col" title="Loss through it, dB">Loss dB</th><th scope="col" title="Low-pass through it, Hz">Low-pass Hz</th><th scope="col" title="How much of the reverb send it cuts, 0 to 1">Wet cut</th><th scope="col"><span class="sp-sr">Remove</span></th></tr>
          </thead>
          <tbody>
            {occ.materials.map((m) => (
              <tr key={m.name}>
                <td><input type="radio" name="sp-default-material" aria-label={`${m.name} is the default`} checked={occ.defaultMaterial === m.name} disabled={ro} onChange={() => onEdit("Default material", (p) => setDefaultMaterial(p, m.name))} /></td>
                <td>
                  {isBuiltinMaterial(m.name) ? <span title="Built in: change it, but it keeps its name">{m.name}</span> : (
                    <input class="sp-mat-name" aria-label="Material name" value={m.name} disabled={ro}
                      onChange={(e) => { const v = (e.currentTarget as HTMLInputElement).value; if (!onEdit("Rename material", (p) => editMaterial(p, m.name, { name: v }))) (e.currentTarget as HTMLInputElement).value = m.name; }} />
                  )}
                </td>
                <td><NumberBox label={`${m.name} loss`} value={m.transmissionDb} min={MATERIAL_LIMITS.transmissionDb[0]} max={MATERIAL_LIMITS.transmissionDb[1]} step={1} digits={0} disabled={ro} onValue={(v) => onEdit("Edit material", (p) => editMaterial(p, m.name, { transmissionDb: v }))} /></td>
                <td><NumberBox label={`${m.name} low-pass`} value={m.cutoffHz} min={MATERIAL_LIMITS.cutoffHz[0]} max={MATERIAL_LIMITS.cutoffHz[1]} step={100} digits={0} disabled={ro} onValue={(v) => onEdit("Edit material", (p) => editMaterial(p, m.name, { cutoffHz: v }))} /></td>
                <td><NumberBox label={`${m.name} wet cut`} value={m.wetOcclusion} min={0} max={1} step={0.05} digits={2} disabled={ro} onValue={(v) => onEdit("Edit material", (p) => editMaterial(p, m.name, { wetOcclusion: v }))} /></td>
                <td>
                  {!isBuiltinMaterial(m.name) && (
                    <button type="button" class="sp-icon" aria-label={`Remove ${m.name}`} disabled={ro || occ.defaultMaterial === m.name} title={occ.defaultMaterial === m.name ? "The default material stays" : "Remove it (obstacles naming it use the default)"} onClick={() => onEdit("Remove material", (p) => removeMaterial(p, m.name))}><Icon name="close" size={14} /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Section>
      <Section title="Doppler" hint="100% is physically accurate. Most games sound better around 50%.">
        <FieldRow label="Amount" unit="%">
          <input type="range" class="sp-range" aria-label="Doppler amount slider" min={0} max={200} step={5} value={dopplerPercent(mix)} disabled={ro}
            onInput={(e) => onEdit("Doppler amount", (p) => setDopplerPercent(p, Number((e.currentTarget as HTMLInputElement).value)), true)} onChange={props.onEndDrag} />
          <NumberBox label="Doppler amount" value={dopplerPercent(mix)} min={0} max={200} step={5} digits={0} disabled={ro} onValue={(v) => onEdit("Doppler amount", (p) => setDopplerPercent(p, v))} />
        </FieldRow>
      </Section>
    </div>
  );
}
