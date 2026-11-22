/**
 * Test kit: the structural checks the migration's tests hold every migrated playlist to (ADR 0329): a Clip has exactly
 * one sample entry and samples sit only in Clips; Switch maps point at real entries; a sequence clip has exactly one of
 * `sample` / `playlist`; Blend entries have a position; Queue and Switch blocks match the type. Returns problems.
 */
import type { Entry, PlaylistBody } from "../../playlist/types";

export function validatePlaylist(body: PlaylistBody, where = "root", out: string[] = []): string[] {
  const entryBody = (e: Entry, w: string): void => {
    if (e.kind === "embedded") validatePlaylist(e.embedded, w, out);
    else if (e.kind === "sample" && body.type !== "clip") out.push(`${w}: a sample outside a Clip.`);
  };
  const samples = body.entries.filter((e) => e.kind === "sample").length;
  if (body.type === "clip" && (samples !== 1 || body.entries.length !== 1)) out.push(`${where}: a Clip needs exactly one sample entry.`);
  if ((body.type === "queue") !== (body.queue !== null)) out.push(`${where}: queue block does not match the type.`);
  if ((body.type === "switch") !== (body.switch !== null)) out.push(`${where}: switch block does not match the type.`);
  if ((body.type === "blend") !== (body.blend !== null)) out.push(`${where}: blend block does not match the type.`);
  if ((body.type === "sequence") !== (body.sequence !== null)) out.push(`${where}: sequence block does not match the type.`);
  if (body.switch) {
    for (const [label, i] of Object.entries(body.switch.map)) {
      if (i !== null && !(Number.isInteger(i) && i >= 0 && i < body.entries.length)) out.push(`${where}: label "${label}" maps to a missing entry ${i}.`);
    }
    for (const r of body.switch.rules) {
      if (r.from !== "*" && !(r.from in body.switch.map)) out.push(`${where}: rule from unknown label "${r.from}".`);
      if (r.to !== "*" && !(r.to in body.switch.map)) out.push(`${where}: rule to unknown label "${r.to}".`);
      if (r.transition) entryBody(r.transition, `${where}.rule.transition`);
    }
    if (body.switch.onChange.transition) entryBody(body.switch.onChange.transition, `${where}.onChange.transition`);
  }
  if (body.type === "blend") body.entries.forEach((e, i) => { if (typeof e.x !== "number") out.push(`${where}.entries[${i}]: no x.`); });
  if (body.type === "queue") body.entries.forEach((e, i) => { if (!(e.weight >= 0 && e.weight <= 100)) out.push(`${where}.entries[${i}]: weight ${e.weight}.`); });
  body.entries.forEach((e, i) => entryBody(e, `${where}.entries[${i}]`));
  body.stingers.forEach((s, i) => entryBody(s.playlist, `${where}.stingers[${i}]`));
  if (body.sequence) {
    const ids = new Set<string>();
    for (const t of body.sequence.tracks) {
      for (const c of t.clips) {
        if (ids.has(c.id)) out.push(`${where}: duplicate clip id ${c.id}.`);
        ids.add(c.id);
        if ((c.sample === undefined) === (c.playlist === undefined)) out.push(`${where}.${c.id}: a clip needs exactly one source.`);
        if (t.kind === "audio" && c.sample === undefined) out.push(`${where}.${c.id}: an audio track holds samples.`);
        if (t.kind === "playlist" && c.playlist === undefined) out.push(`${where}.${c.id}: a playlist track holds playlists.`);
        if (c.playlist !== undefined && typeof c.playlist !== "string") validatePlaylist(c.playlist, `${where}.${c.id}`, out);
      }
    }
    for (const l of body.sequence.loops) if (!(l.end > l.start)) out.push(`${where}: loop ${l.id} is empty.`);
  }
  return out;
}
