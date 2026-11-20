// A random v4 UUID: `crypto.randomUUID`, or built from random bytes where it's missing (plain-http pages, which
// aren't a secure context). One module for every id the editor mints this way: panel instances, navigation agent
// types and areas.

/** A new random (version 4) UUID, `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`. */
export function randomUuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
