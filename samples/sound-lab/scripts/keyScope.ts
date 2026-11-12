/**
 * Key scopes for the Sound Lab. The main page's own handlers (OneShots on 1, Buses on 2 and 3, Snapshots on 4, Effects on
 * 5 and 6, the listening bench's 0 and 7 to 9) read keys that a page, test or tool added on top of it may want for itself.
 * Such a page calls `claimKeys()` (from a script) or `globalThis.__soundLabKeys.claim()` (from a test or the console) and
 * gets a release function back; while any claim is held the main page's handlers ignore the keyboard, so a key does what
 * the claiming page says and nothing else. The state lives on `globalThis`, not in the module, because each behaviour
 * file may be loaded as a module of its own.
 */
interface KeyScopes {
  claims: number;
  claim(): () => void;
}

function scopes(): KeyScopes {
  const g = globalThis as unknown as { __soundLabKeys?: KeyScopes };
  if (!g.__soundLabKeys) {
    const s: KeyScopes = {
      claims: 0,
      claim() {
        s.claims++;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          s.claims--;
        };
      },
    };
    g.__soundLabKeys = s;
  }
  return g.__soundLabKeys;
}

/** True while a page holds the keyboard: the main page's handlers return without reading keys. */
export function keysClaimed(): boolean {
  return scopes().claims > 0;
}

/** Takes the keyboard from the main page's handlers until the returned function is called. */
export function claimKeys(): () => void {
  return scopes().claim();
}

/** Makes `globalThis.__soundLabKeys` exist (the main page's handlers call this in `start`, so a test can claim before any key). */
export function exposeKeyScopes(): void {
  scopes();
}
