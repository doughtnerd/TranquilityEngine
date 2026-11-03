import { useRef, useState } from "preact/hooks";
import {
  BEHAVIOR_LABELS,
  BEHAVIOR_TYPES,
  SHAPE_TYPES,
  defaultBehavior,
  defaultEmitter,
  type ParticleBehavior,
  type ParticleBehaviorType,
  type ParticleBlending,
  type ParticleBurst,
  type ParticleColor,
  type ParticleEffect,
  type ParticleEmitterSettings,
  type ParticleNumber,
  type ParticleRenderMode,
  type ParticleRenderer,
  type ParticleShape,
  type ParticleSubEmitter,
  type ShapeMode,
  type ShapeType,
} from "../../../engine/scene/particles";
import { NumField, ParticleColorInput, ParticleNumberInput, VecField } from "./valueInputs";
import "./particles.css";

const RENDER_MODES: ParticleRenderMode[] = ["billboard", "stretched", "horizontal", "vertical", "mesh", "trail"];
const BLENDINGS: ParticleBlending[] = ["additive", "alpha", "premultiplied"];
const SHAPE_MODES: ShapeMode[] = ["random", "loop", "pingpong", "burst"];
const TRIGGERS: ParticleSubEmitter["trigger"][] = ["birth", "death", "frame"];
/** Behaviour fields that are plain numbers, not number values (they can't be curves). */
const PLAIN_NUMBERS = new Set(["strength", "dampen", "min", "max", "height", "bounce", "octaves"]);

/** The shape fields each shape type uses. */
const SHAPE_FIELDS: Record<ShapeType, (keyof ParticleShape)[]> = {
  point: [],
  sphere: ["radius", "arc", "thickness", "mode", "spread"],
  hemisphere: ["radius", "arc", "thickness", "mode", "spread"],
  cone: ["radius", "angle", "arc", "thickness", "mode", "spread"],
  circle: ["radius", "arc", "thickness", "mode", "spread"],
  donut: ["radius", "donutRadius", "arc", "thickness", "mode", "spread"],
  rectangle: ["width", "height", "thickness"],
  grid: ["width", "height", "columns", "rows"],
};

const move = <T,>(list: T[], from: number, to: number): T[] => {
  if (to < 0 || to >= list.length) return list;
  const next = list.slice();
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
};
const replaceAt = <T,>(list: T[], i: number, item: T): T[] => list.map((x, j) => (j === i ? item : x));
const without = <T,>(list: T[], i: number): T[] => list.filter((_, j) => j !== i);
/** `name`, or `name 2`, `name 3`… when taken. */
const uniqueName = (taken: string[], name: string) => {
  if (!taken.includes(name)) return name;
  const base = name.replace(/ \d+$/, "");
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
};

let listIds = 0;

/** A labelled row of fields. */
function Row(props: { label: string; children: preact.ComponentChildren }) {
  return (
    <div class="pe-row">
      <span class="pe-label" title={props.label}>
        {props.label}
      </span>
      <span class="pe-value">{props.children}</span>
    </div>
  );
}

function Section(props: { title: string; open?: boolean; badge?: string | number; children: preact.ComponentChildren }) {
  return (
    <details class="pe-section" open={props.open}>
      <summary>
        {props.title}
        {props.badge !== undefined && <span class="pe-badge">{props.badge}</span>}
      </summary>
      <div class="pe-section-body">{props.children}</div>
    </details>
  );
}

function Check(props: { checked: boolean; label: string; onChange: (v: boolean) => void }) {
  return <input type="checkbox" aria-label={props.label} checked={props.checked} onChange={(e) => props.onChange((e.currentTarget as HTMLInputElement).checked)} />;
}

function Select<T extends string>(props: { value: T; options: readonly T[]; label: string; onChange: (v: T) => void }) {
  return (
    <select class="choice-input" aria-label={props.label} value={props.value} onChange={(e) => props.onChange((e.currentTarget as HTMLSelectElement).value as T)}>
      {props.options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

/** A text field with a suggestions list (asset paths). */
function AssetField(props: { value: string; label: string; options: string[]; onChange: (v: string) => void }) {
  const id = useRef(`pe-list-${++listIds}`);
  return (
    <>
      <input type="text" class="pe-text" aria-label={props.label} list={id.current} value={props.value} onInput={(e) => props.onChange((e.currentTarget as HTMLInputElement).value)} />
      <datalist id={id.current}>
        {props.options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
}

/** The emitter's name; renaming commits as long as the text isn't empty. */
function NameField(props: { value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="text"
      class="pe-text pe-name"
      aria-label="emitter name"
      value={draft ?? props.value}
      onInput={(e) => {
        const text = (e.currentTarget as HTMLInputElement).value;
        setDraft(text);
        if (text.trim()) props.onChange(text);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

/**
 * A particle effect's emitters (ADR 0057) in inspector style: Unity-like collapsible modules for
 * the selected emitter. Controlled: every edit calls `onChange` with a new effect.
 */
export function ParticleEffectEditor(props: { effect: ParticleEffect; onChange: (effect: ParticleEffect) => void; readOnly?: boolean; assetList?: (kind: "material" | "texture" | "mesh") => string[] }) {
  const { effect, readOnly } = props;
  // Read-only: the inputs show as disabled and edits are dropped, but sections, tabs and the curve
  // and gradient previews still open, so the effect can be looked at.
  const onChange = readOnly ? () => {} : props.onChange;
  const assets = props.assetList ?? (() => []);
  const [picked, setPicked] = useState(0);
  const index = Math.min(picked, effect.emitters.length - 1);
  const emitter: ParticleEmitterSettings | undefined = effect.emitters[index];
  const names = effect.emitters.map((e) => e.name);

  const setEmitters = (emitters: ParticleEmitterSettings[]) => onChange({ ...effect, emitters });
  const edit = (patch: Partial<ParticleEmitterSettings>) => setEmitters(replaceAt(effect.emitters, index, { ...emitter, ...patch }));

  const addEmitter = () => {
    setEmitters([...effect.emitters, defaultEmitter(uniqueName(names, "Emitter"))]);
    setPicked(effect.emitters.length);
  };
  const duplicate = () => {
    const copy = structuredClone(emitter);
    copy.name = uniqueName(names, `${emitter.name} copy`);
    setEmitters([...effect.emitters.slice(0, index + 1), copy, ...effect.emitters.slice(index + 1)]);
    setPicked(index + 1);
  };
  const removeEmitter = () => {
    // Sub-emitter links to the removed emitter go with it.
    const gone = emitter.name;
    setEmitters(without(effect.emitters, index).map((e) => ({ ...e, subEmitters: e.subEmitters.filter((s) => s.emitter !== gone) })));
    setPicked(Math.max(0, index - 1));
  };
  const rename = (name: string) => {
    const old = emitter.name;
    setEmitters(effect.emitters.map((e, i) => ({ ...(i === index ? { ...e, name } : e), subEmitters: e.subEmitters.map((s) => (s.emitter === old ? { ...s, emitter: name } : s)) })));
  };

  return (
    <fieldset class={`particle-effect-editor${readOnly ? " read-only" : ""}`} aria-label="Particle effect">
      <div class="pe-tabs" role="tablist">
        {effect.emitters.map((e, i) => (
          <button key={i} type="button" role="tab" class={`pe-tab${i === index ? " active" : ""}${e.enabled ? "" : " off"}`} aria-selected={i === index} onClick={() => setPicked(i)}>
            {e.name}
          </button>
        ))}
        <button type="button" class="pe-tab pe-add" aria-label="Add emitter" title="Add emitter" onClick={addEmitter}>
          +
        </button>
      </div>
      {!emitter ? (
        <p class="pe-empty">This effect has no emitters.</p>
      ) : (
        <>
          <div class="pe-emitter-head">
            <Check checked={emitter.enabled} label="emitter enabled" onChange={(enabled) => edit({ enabled })} />
            <NameField value={emitter.name} onChange={rename} />
            <button type="button" class="pe-mini" aria-label="Duplicate emitter" onClick={duplicate}>
              Duplicate
            </button>
            <button type="button" class="pe-mini pe-danger" aria-label="Remove emitter" onClick={removeEmitter}>
              Remove
            </button>
          </div>
          <MainSection emitter={emitter} edit={edit} readOnly={readOnly} />
          <EmissionSection emitter={emitter} edit={edit} readOnly={readOnly} />
          <ShapeSection shape={emitter.shape} onChange={(shape) => edit({ shape })} />
          <BehaviorsSection behaviors={emitter.behaviors} onChange={(behaviors) => edit({ behaviors })} readOnly={readOnly} />
          <SubEmittersSection emitter={emitter} others={names.filter((_, i) => i !== index)} onChange={(subEmitters) => edit({ subEmitters })} />
          <RendererSection renderer={emitter.renderer} onChange={(renderer) => edit({ renderer })} assets={assets} readOnly={readOnly} />
        </>
      )}
    </fieldset>
  );
}

type Edit = (patch: Partial<ParticleEmitterSettings>) => void;

function MainSection(props: { emitter: ParticleEmitterSettings; edit: Edit; readOnly?: boolean }) {
  const { emitter: e, edit, readOnly } = props;
  const number = (key: "startLife" | "startSpeed" | "startSize" | "startRotation") => <ParticleNumberInput label={key} value={e[key]} readOnly={readOnly} onChange={(v) => edit({ [key]: v })} />;
  return (
    <Section title="Main" open>
      <Row label="duration">
        <NumField value={e.duration} label="duration" min={0.01} onCommit={(duration) => edit({ duration })} />
      </Row>
      <Row label="looping">
        <Check checked={e.looping} label="looping" onChange={(looping) => edit({ looping })} />
      </Row>
      <Row label="prewarm">
        <Check checked={e.prewarm} label="prewarm" onChange={(prewarm) => edit({ prewarm })} />
      </Row>
      <Row label="startDelay">
        <NumField value={e.startDelay} label="startDelay" min={0} onCommit={(startDelay) => edit({ startDelay })} />
      </Row>
      {number("startLife")}
      {number("startSpeed")}
      {number("startSize")}
      {number("startRotation")}
      <ParticleColorInput label="startColor" value={e.startColor} readOnly={readOnly} onChange={(startColor) => edit({ startColor })} />
      <Row label="gravity">
        <NumField value={e.gravity} label="gravity" onCommit={(gravity) => edit({ gravity })} />
      </Row>
      <Row label="space">
        <Select label="space" value={e.space} options={["local", "world"] as const} onChange={(space) => edit({ space })} />
      </Row>
      <Row label="maxParticles">
        <NumField value={e.maxParticles} label="maxParticles" integer min={1} onCommit={(maxParticles) => edit({ maxParticles })} />
      </Row>
    </Section>
  );
}

function EmissionSection(props: { emitter: ParticleEmitterSettings; edit: Edit; readOnly?: boolean }) {
  const { emitter, edit, readOnly } = props;
  const em = emitter.emission;
  const set = (patch: Partial<typeof em>) => edit({ emission: { ...em, ...patch } });
  const setBurst = (i: number, patch: Partial<ParticleBurst>) => set({ bursts: replaceAt(em.bursts, i, { ...em.bursts[i], ...patch }) });
  return (
    <Section title="Emission" open badge={em.bursts.length || undefined}>
      <ParticleNumberInput label="rateOverTime" value={em.rateOverTime} readOnly={readOnly} onChange={(rateOverTime) => set({ rateOverTime })} />
      <ParticleNumberInput label="rateOverDistance" value={em.rateOverDistance} readOnly={readOnly} onChange={(rateOverDistance) => set({ rateOverDistance })} />
      <div class="pe-list-head">
        <span>Bursts</span>
        <button type="button" class="pe-mini" aria-label="Add burst" onClick={() => set({ bursts: [...em.bursts, { time: 0, count: 10, cycles: 1, interval: 0.1, probability: 1 }] })}>
          Add burst
        </button>
      </div>
      {em.bursts.map((b, i) => (
        <div key={i} class="pe-card" data-burst={i}>
          <div class="pe-card-head">
            <span class="pe-card-title">Burst {i + 1}</span>
            <button type="button" class="pe-mini pe-danger" aria-label={`Remove burst ${i + 1}`} onClick={() => set({ bursts: without(em.bursts, i) })}>
              Remove
            </button>
          </div>
          <Row label="time">
            <NumField value={b.time} label={`burst ${i + 1} time`} min={0} onCommit={(time) => setBurst(i, { time })} />
          </Row>
          <ParticleNumberInput label={`burst ${i + 1} count`} value={b.count} allowCurves={false} readOnly={readOnly} onChange={(count) => setBurst(i, { count })} />
          <Row label="cycles">
            <NumField value={b.cycles} label={`burst ${i + 1} cycles`} integer min={1} onCommit={(cycles) => setBurst(i, { cycles })} />
          </Row>
          <Row label="interval">
            <NumField value={b.interval} label={`burst ${i + 1} interval`} min={0} onCommit={(interval) => setBurst(i, { interval })} />
          </Row>
          <Row label="probability">
            <NumField value={b.probability} label={`burst ${i + 1} probability`} min={0} max={1} onCommit={(probability) => setBurst(i, { probability })} />
          </Row>
        </div>
      ))}
    </Section>
  );
}

function ShapeSection(props: { shape: ParticleShape; onChange: (s: ParticleShape) => void }) {
  const { shape, onChange } = props;
  const fields = SHAPE_FIELDS[shape.type];
  const num = (key: keyof ParticleShape, extra: { integer?: boolean; min?: number; max?: number } = {}) =>
    fields.includes(key) && (
      <Row label={key}>
        <NumField value={shape[key] as number} label={key} {...extra} onCommit={(n) => onChange({ ...shape, [key]: n })} />
      </Row>
    );
  return (
    <Section title="Shape" open>
      <Row label="type">
        <Select label="shape type" value={shape.type} options={SHAPE_TYPES} onChange={(type) => onChange({ ...shape, type })} />
      </Row>
      {num("radius", { min: 0 })}
      {num("donutRadius", { min: 0 })}
      {num("angle", { min: 0, max: 90 })}
      {num("arc", { min: 0, max: 360 })}
      {num("thickness", { min: 0, max: 1 })}
      {num("width", { min: 0 })}
      {num("height", { min: 0 })}
      {num("columns", { integer: true, min: 1 })}
      {num("rows", { integer: true, min: 1 })}
      {fields.includes("mode") && (
        <Row label="mode">
          <Select label="shape mode" value={shape.mode} options={SHAPE_MODES} onChange={(mode) => onChange({ ...shape, mode })} />
        </Row>
      )}
      {fields.includes("spread") && (shape.mode === "loop" || shape.mode === "pingpong") && num("spread", { min: 0, max: 1 })}
      <Row label="position">
        <VecField label="shape position" value={shape.position} onChange={(position) => onChange({ ...shape, position })} />
      </Row>
      <Row label="rotation">
        <VecField label="shape rotation" value={shape.rotation} onChange={(rotation) => onChange({ ...shape, rotation })} />
      </Row>
    </Section>
  );
}

function BehaviorsSection(props: { behaviors: ParticleBehavior[]; onChange: (b: ParticleBehavior[]) => void; readOnly?: boolean }) {
  const { behaviors, onChange, readOnly } = props;
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  return (
    <Section title="Behaviours" open badge={behaviors.length || undefined}>
      {behaviors.map((b, i) => {
        const title = BEHAVIOR_LABELS[b.type];
        const closed = collapsed.has(i);
        const set = (patch: Record<string, unknown>) => onChange(replaceAt(behaviors, i, { ...b, ...patch } as ParticleBehavior));
        return (
          <div key={i} class={`pe-card${b.enabled === false ? " off" : ""}`} data-behavior={b.type}>
            <div class="pe-card-head">
              <button
                type="button"
                class="pe-fold"
                aria-label={`${closed ? "Expand" : "Collapse"} ${title}`}
                aria-expanded={!closed}
                onClick={() => setCollapsed((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : new Set([...s, i])))}
              >
                {closed ? "▸" : "▾"}
              </button>
              <Check checked={b.enabled !== false} label={`${title} enabled`} onChange={(on) => set({ enabled: on ? undefined : false })} />
              <span class="pe-card-title">{title}</span>
              <button type="button" class="pe-mini" aria-label={`Move ${title} up`} disabled={i === 0} onClick={() => onChange(move(behaviors, i, i - 1))}>
                {"↑"}
              </button>
              <button type="button" class="pe-mini" aria-label={`Move ${title} down`} disabled={i === behaviors.length - 1} onClick={() => onChange(move(behaviors, i, i + 1))}>
                {"↓"}
              </button>
              <button type="button" class="pe-mini pe-danger" aria-label={`Remove ${title}`} onClick={() => onChange(without(behaviors, i))}>
                {"×"}
              </button>
            </div>
            {!closed && <BehaviorFields behavior={b} title={title} set={set} readOnly={readOnly} />}
          </div>
        );
      })}
      <select
        class="choice-input pe-add-behavior"
        aria-label="Add behaviour"
        value=""
        onChange={(e) => {
          const type = (e.currentTarget as HTMLSelectElement).value as ParticleBehaviorType;
          (e.currentTarget as HTMLSelectElement).value = "";
          if (type) onChange([...behaviors, defaultBehavior(type)]);
        }}
      >
        <option value="">Add behaviour...</option>
        {BEHAVIOR_TYPES.map((t) => (
          <option key={t} value={t}>
            {BEHAVIOR_LABELS[t]}
          </option>
        ))}
      </select>
    </Section>
  );
}

/** A behaviour's fields, in the order its defaults list them, each edited by what its value is. */
function BehaviorFields(props: { behavior: ParticleBehavior; title: string; set: (patch: Record<string, unknown>) => void; readOnly?: boolean }) {
  const { behavior, title, set, readOnly } = props;
  const values = behavior as unknown as Record<string, unknown>;
  const keys = Object.keys(defaultBehavior(behavior.type)).filter((k) => k !== "type");
  return (
    <div class="pe-card-body">
      {keys.map((key) => {
        const label = `${title} ${key}`;
        const value = values[key];
        if (key === "color") return <ParticleColorInput key={key} label={label} value={value as ParticleColor} readOnly={readOnly} onChange={(v) => set({ [key]: v })} />;
        if (typeof value === "boolean") {
          return (
            <Row key={key} label={key}>
              <Check checked={value} label={label} onChange={(v) => set({ [key]: v })} />
            </Row>
          );
        }
        if (Array.isArray(value)) {
          return (
            <Row key={key} label={key}>
              <VecField label={label} value={value as [number, number, number]} onChange={(v) => set({ [key]: v })} />
            </Row>
          );
        }
        if (PLAIN_NUMBERS.has(key)) {
          return (
            <Row key={key} label={key}>
              <NumField value={value as number} label={label} integer={key === "octaves"} min={key === "octaves" ? 1 : undefined} onCommit={(v) => set({ [key]: v })} />
            </Row>
          );
        }
        return <ParticleNumberInput key={key} label={label} value={value as ParticleNumber} readOnly={readOnly} onChange={(v) => set({ [key]: v })} />;
      })}
    </div>
  );
}

function SubEmittersSection(props: { emitter: ParticleEmitterSettings; others: string[]; onChange: (s: ParticleSubEmitter[]) => void }) {
  const { emitter, others, onChange } = props;
  const subs = emitter.subEmitters;
  const setSub = (i: number, patch: Partial<ParticleSubEmitter>) => onChange(replaceAt(subs, i, { ...subs[i], ...patch }));
  return (
    <Section title="Sub-emitters" badge={subs.length || undefined}>
      {subs.map((s, i) => (
        <div key={i} class="pe-card" data-sub-emitter={i}>
          <div class="pe-card-head">
            <span class="pe-card-title">Sub-emitter {i + 1}</span>
            <button type="button" class="pe-mini pe-danger" aria-label={`Remove sub-emitter ${i + 1}`} onClick={() => onChange(without(subs, i))}>
              Remove
            </button>
          </div>
          <Row label="emitter">
            <select class="choice-input" aria-label={`sub-emitter ${i + 1} emitter`} value={s.emitter} onChange={(e) => setSub(i, { emitter: (e.currentTarget as HTMLSelectElement).value })}>
              {!others.includes(s.emitter) && <option value={s.emitter}>{s.emitter || "(none)"} (missing)</option>}
              {others.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Row>
          <Row label="trigger">
            <Select label={`sub-emitter ${i + 1} trigger`} value={s.trigger} options={TRIGGERS} onChange={(trigger) => setSub(i, { trigger })} />
          </Row>
          <Row label="probability">
            <NumField value={s.probability} label={`sub-emitter ${i + 1} probability`} min={0} max={1} onCommit={(probability) => setSub(i, { probability })} />
          </Row>
          <Row label="inheritVelocity">
            <Check checked={s.inheritVelocity} label={`sub-emitter ${i + 1} inheritVelocity`} onChange={(inheritVelocity) => setSub(i, { inheritVelocity })} />
          </Row>
        </div>
      ))}
      <button
        type="button"
        class="pe-mini"
        aria-label="Add sub-emitter"
        disabled={!others.length}
        title={others.length ? "" : "Add another emitter first"}
        onClick={() => onChange([...subs, { emitter: others[0], trigger: "death", probability: 1, inheritVelocity: false }])}
      >
        Add sub-emitter
      </button>
    </Section>
  );
}

function RendererSection(props: { renderer: ParticleRenderer; onChange: (r: ParticleRenderer) => void; assets: (kind: "material" | "texture" | "mesh") => string[]; readOnly?: boolean }) {
  const { renderer: r, onChange, assets, readOnly } = props;
  const set = (patch: Partial<ParticleRenderer>) => onChange({ ...r, ...patch });
  return (
    <Section title="Renderer" open>
      <Row label="mode">
        <Select label="renderer mode" value={r.mode} options={RENDER_MODES} onChange={(mode) => set({ mode })} />
      </Row>
      <Row label="material">
        <AssetField label="material" value={r.material} options={assets("material")} onChange={(material) => set({ material })} />
      </Row>
      {!r.material && (
        <>
          <Row label="texture">
            <AssetField label="texture" value={r.texture} options={assets("texture")} onChange={(texture) => set({ texture })} />
          </Row>
          <Row label="blending">
            <Select label="blending" value={r.blending} options={BLENDINGS} onChange={(blending) => set({ blending })} />
          </Row>
        </>
      )}
      <Row label="tiles">
        <span class="pe-pair">
          <NumField value={r.tiles[0]} label="tiles u" integer min={1} onCommit={(u) => set({ tiles: [u, r.tiles[1]] })} />
          <NumField value={r.tiles[1]} label="tiles v" integer min={1} onCommit={(v) => set({ tiles: [r.tiles[0], v] })} />
        </span>
      </Row>
      <ParticleNumberInput label="startTile" value={r.startTile} readOnly={readOnly} onChange={(startTile) => set({ startTile })} />
      <Row label="blendTiles">
        <Check checked={r.blendTiles} label="blendTiles" onChange={(blendTiles) => set({ blendTiles })} />
      </Row>
      {r.mode === "mesh" && (
        <Row label="mesh">
          <AssetField label="mesh" value={r.mesh} options={["builtin:cube", ...assets("mesh")]} onChange={(mesh) => set({ mesh })} />
        </Row>
      )}
      {r.mode === "stretched" && (
        <>
          <Row label="speedScale">
            <NumField value={r.speedScale} label="speedScale" onCommit={(speedScale) => set({ speedScale })} />
          </Row>
          <Row label="lengthScale">
            <NumField value={r.lengthScale} label="lengthScale" onCommit={(lengthScale) => set({ lengthScale })} />
          </Row>
        </>
      )}
      {r.mode === "trail" && <ParticleNumberInput label="trailLength" value={r.trailLength} readOnly={readOnly} onChange={(trailLength) => set({ trailLength })} />}
      <Row label="renderOrder">
        <NumField value={r.renderOrder} label="renderOrder" integer onCommit={(renderOrder) => set({ renderOrder })} />
      </Row>
    </Section>
  );
}
