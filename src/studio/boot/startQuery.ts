// What the Studio opens on start-up (ADR 0327): `?sample=<id>` a sample (read-only), `?project=<folder>` a project
// folder (on desktop, where folders are opened by path; the editor's hand-off opens it so), else the start screen.
// The screen and asset come from the hash (`route.ts`).

export type StartRequest = { readonly kind: "folder"; readonly root: string } | { readonly kind: "sample"; readonly id: string } | null;

/** The request in a page's query string. A sample wins over a folder when both are given. */
export function startRequest(search: string): StartRequest {
  const params = new URLSearchParams(search);
  const sample = params.get("sample")?.trim();
  if (sample) return { kind: "sample", id: sample };
  const root = params.get("project")?.trim();
  return root ? { kind: "folder", root } : null;
}
