// The skeleton profile (chain) editor (ADR 0373 "A chain editor for custom profiles"; T54): a `*.skelprofile.json` selected
// in the Assets panel shows its roles (name, mirror partner, flip, joint range, required), its chains (name, kind, roles in
// order, IK) and its root and hips roles. Every edit is a refused-or-next result of `chainLogic.ts` (validated by the
// profile parse's rules) applied to the profile's asset document: one labelled undo step each, with Undo and Redo in the
// frame's head (ADR 0265).
import { useState } from "preact/hooks";
import { AssetDocumentFrame, applyToDocument, editor, openAssetDocument, type AssetDocument, type EditResult, EmptyState } from "../../../../editor/sdk";
import { CHAIN_KINDS, FLIPS, type ChainKind, type Flip, type JointRange, type SkeletonProfile } from "../../../../engine/animation/skeletonProfile";
import { addChain, addRole, freshName, moveChainRole, removeChain, removeRole, renameChain, renameProfile, renameRole, setChainIk, setChainKind, setChainRoles, setFlip, setMirror, setRange, setRequired, setRootRole } from "./chainLogic";
import "./skeleton.css";

const FREE: JointRange = { swingY: 180, swingZ: 180, twistMin: -180, twistMax: 180 };
const input = (e: Event) => e.currentTarget as HTMLInputElement;
const select = (e: Event) => e.currentTarget as HTMLSelectElement;

/** The selected skeleton profile (see the file comment). */
export function ProfileEditor(props: { path: string }) {
  editor.project.version; // files change under it
  const project = editor.project.current;
  if (!project) return <EmptyState compact title="Nothing selected" />;
  const doc = openAssetDocument<SkeletonProfile>(project, props.path, "skelprofile");
  const p = doc.value.value;
  const readOnly = doc.readOnly;
  const apply = (result: EditResult<SkeletonProfile>, label: string) => applyToDocument(doc, result, label);
  return (
    <AssetDocumentFrame doc={doc} kind="Skeleton Profile" class="inspector-body asset-inspector skeleton-profile">
      <div class="component asset-import-card">
        <h3>Profile</h3>
        <label class="import-row">
          <span>Name</span>
          <input type="text" aria-label="Profile name" disabled={readOnly} value={p.name} onChange={(e) => apply(renameProfile(p, input(e).value), "Rename the profile")} />
        </label>
        {(["root", "hips"] as const).map((which) => (
          <label class="import-row" key={which} title={which === "root" ? "The role root motion follows" : "The role the retarget scales from (not the same role as root)"}>
            <span>{which === "root" ? "Root role" : "Hips role"}</span>
            <select aria-label={which === "root" ? "Root role" : "Hips role"} disabled={readOnly} value={p[which] ?? ""} onChange={(e) => apply(setRootRole(p, which, select(e).value || null), `Set the ${which} role`)}>
              <option value="">(none)</option>
              {p.roles.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <RolesCard p={p} doc={doc} apply={apply} />
      <ChainsCard p={p} doc={doc} apply={apply} />
    </AssetDocumentFrame>
  );
}

interface CardProps {
  readonly p: SkeletonProfile;
  readonly doc: AssetDocument<SkeletonProfile>;
  apply(result: EditResult<SkeletonProfile>, label: string): boolean;
}

function RolesCard({ p, doc, apply }: CardProps) {
  const [name, setName] = useState("");
  const readOnly = doc.readOnly;
  return (
    <div class="component asset-import-card">
      <h3>Roles</h3>
      <table class="profile-table" aria-label="Roles">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Mirror</th>
            <th scope="col">Flip</th>
            <th scope="col" title="The retarget needs a bone for it">
              Req.
            </th>
            <th scope="col" title="Joint range, degrees: swing Y, swing Z, twist min, twist max (unticked: free)">
              Range
            </th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {p.roles.map((r) => (
            <tr key={r.name}>
              <td>
                <input type="text" aria-label={`Name of ${r.name}`} disabled={readOnly} value={r.name} onChange={(e) => apply(renameRole(p, r.name, input(e).value), `Rename ${r.name}`)} />
              </td>
              <td>
                <select aria-label={`Mirror of ${r.name}`} disabled={readOnly} value={r.mirror === r.name ? "" : r.mirror} onChange={(e) => apply(setMirror(p, r.name, select(e).value || null), `Set the mirror of ${r.name}`)}>
                  <option value="">(centre)</option>
                  {p.roles.filter((o) => o.name !== r.name).map((o) => (
                    <option key={o.name} value={o.name}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select aria-label={`Flip of ${r.name}`} disabled={readOnly} value={r.flip} onChange={(e) => apply(setFlip(p, r.name, select(e).value as Flip), `Set the flip of ${r.name}`)}>
                  {FLIPS.map((f) => (
                    <option key={f} value={f}>
                      {f === "auto" ? "auto (from the rest pose)" : f}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input type="checkbox" aria-label={`${r.name} is required`} disabled={readOnly} checked={r.required} onChange={(e) => apply(setRequired(p, r.name, input(e).checked), `Set ${r.name} ${input(e).checked ? "required" : "optional"}`)} />
              </td>
              <td>
                <RangeCells role={r.name} range={r.range} disabled={readOnly} onChange={(range) => apply(setRange(p, r.name, range), `Set the joint range of ${r.name}`)} />
              </td>
              <td>
                <button aria-label={`Remove ${r.name}`} title={`Remove ${r.name}`} disabled={readOnly || p.roles.length === 1} onClick={() => apply(removeRole(p, r.name), `Remove ${r.name}`)}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="skeleton-actions">
        <input type="text" aria-label="New role name" placeholder="New role" disabled={readOnly} value={name} onInput={(e) => setName(input(e).value)} />
        <button
          disabled={readOnly || name.trim() === ""}
          onClick={() => {
            if (apply(addRole(p, name), `Add the role ${name.trim()}`)) setName("");
          }}
        >
          Add Role
        </button>
      </div>
    </div>
  );
}

/** A role's joint range: a toggle (limited or free) and four numbers. */
function RangeCells(props: { role: string; range: JointRange | null; disabled: boolean; onChange(range: JointRange | null): void }) {
  const { range } = props;
  const field = (key: keyof JointRange, label: string) => (
    <input
      type="number"
      aria-label={`${label} of ${props.role}`}
      title={label}
      step={1}
      disabled={props.disabled}
      value={range![key]}
      onChange={(e) => {
        const v = Number(input(e).value);
        props.onChange({ ...range!, [key]: Number.isFinite(v) ? v : range![key] });
      }}
    />
  );
  return (
    <div class="profile-range">
      <input type="checkbox" aria-label={`${props.role} has a joint range`} disabled={props.disabled} checked={range !== null} onChange={(e) => props.onChange(input(e).checked ? FREE : null)} />
      {range && (
        <>
          {field("swingY", "Swing Y")}
          {field("swingZ", "Swing Z")}
          {field("twistMin", "Twist min")}
          {field("twistMax", "Twist max")}
        </>
      )}
    </div>
  );
}

function ChainsCard({ p, doc, apply }: CardProps) {
  const [name, setName] = useState("");
  const readOnly = doc.readOnly;
  return (
    <div class="component asset-import-card">
      <h3>Chains</h3>
      {p.chains.length === 0 && <p class="skeleton-note">No chains yet. Chains are what the retarget aligns and the IK solves; they run in this order, twists last.</p>}
      {p.chains.map((c) => (
        <div class="profile-chain" key={c.name} aria-label={`Chain ${c.name}`}>
          <div class="profile-chain-head">
            <input type="text" aria-label={`Name of chain ${c.name}`} disabled={readOnly} value={c.name} onChange={(e) => apply(renameChain(p, c.name, input(e).value), `Rename chain ${c.name}`)} />
            <select aria-label={`Kind of ${c.name}`} disabled={readOnly} value={c.kind} onChange={(e) => apply(setChainKind(p, c.name, select(e).value as ChainKind), `Set the kind of ${c.name}`)}>
              {CHAIN_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <label title="Solve this chain with two-bone IK (needs three roles)">
              <input type="checkbox" aria-label={`IK on ${c.name}`} disabled={readOnly} checked={c.ik} onChange={(e) => apply(setChainIk(p, c.name, input(e).checked), `Turn IK ${input(e).checked ? "on" : "off"} for ${c.name}`)} /> IK
            </label>
            <button aria-label={`Remove chain ${c.name}`} title={`Remove ${c.name}`} disabled={readOnly} onClick={() => apply(removeChain(p, c.name), `Remove chain ${c.name}`)}>
              ✕
            </button>
          </div>
          <div class="profile-chain-roles">
            {c.roles.map((role, i) => (
              <div class="profile-chain-role" key={role}>
                <span>{role}</span>
                <button aria-label={`Move ${role} up`} disabled={readOnly || i === 0} onClick={() => apply(moveChainRole(p, c.name, i, -1), `Move ${role} up in ${c.name}`)}>
                  ↑
                </button>
                <button aria-label={`Move ${role} down`} disabled={readOnly || i === c.roles.length - 1} onClick={() => apply(moveChainRole(p, c.name, i, 1), `Move ${role} down in ${c.name}`)}>
                  ↓
                </button>
                <button aria-label={`Remove ${role} from ${c.name}`} disabled={readOnly || c.roles.length === 1} onClick={() => apply(setChainRoles(p, c.name, c.roles.filter((r) => r !== role)), `Remove ${role} from ${c.name}`)}>
                  ✕
                </button>
              </div>
            ))}
            <select
              aria-label={`Add a role to ${c.name}`}
              disabled={readOnly || p.roles.every((r) => c.roles.includes(r.name))}
              value=""
              onChange={(e) => {
                const role = select(e).value;
                if (role) apply(setChainRoles(p, c.name, [...c.roles, role]), `Add ${role} to ${c.name}`);
              }}
            >
              <option value="">Add a role…</option>
              {p.roles.filter((r) => !c.roles.includes(r.name)).map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      ))}
      <div class="skeleton-actions">
        <input type="text" aria-label="New chain name" placeholder={freshName("Chain", p.chains.map((c) => c.name))} disabled={readOnly} value={name} onInput={(e) => setName(input(e).value)} />
        <button
          disabled={readOnly}
          title="A new chain of the first role; add the rest in its card"
          onClick={() => {
            const chain = name.trim() || freshName("Chain", p.chains.map((c) => c.name));
            if (apply(addChain(p, chain, "custom", [p.roles[0].name]), `Add the chain ${chain}`)) setName("");
          }}
        >
          Add Chain
        </button>
      </div>
    </div>
  );
}
