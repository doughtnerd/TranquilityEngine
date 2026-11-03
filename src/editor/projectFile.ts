// Writes to `project.json` from the panels that edit it (Worlds: `bootstrap`; Project: the rest,
// ADR 0038). Each writes only its own keys into the file's current text, so the writes must run
// one at a time: two built from the same text would drop one another's change.

export const PROJECT_FILE = "project.json";

let queue: Promise<void> = Promise.resolve();

/** Run `task` after every write queued before it (a failing task doesn't stop later ones). */
export function queueProjectFileWrite(task: () => Promise<void>): Promise<void> {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}
