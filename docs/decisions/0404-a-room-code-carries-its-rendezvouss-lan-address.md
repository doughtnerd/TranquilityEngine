# 0404. A room code carries its rendezvous's LAN address; without one it uses the configured hosted rendezvous

- **Status:** Accepted (owner decision O7, 2026-11-23)
- **Date:** 2026-11-23
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0403 (amended: "Pairing code" and "Rendezvous"), 0067 (paths on one port)

## Context

0403 has two kinds of pairing code. An address code names a listener. A room code names "a rendezvous room and a
token, for pairs where neither side can reach a listener on the other". It doesn't say **which rendezvous**. Two pages
served by different servers, such as a web export on `serve.mjs` on one machine and the browser Studio from
`npm run dev` on another, each know only their own server, so they can't meet in a room. The plan's review found this
(finding 5); the owner chose to have the code carry the rendezvous (O7).

A code is 10 Crockford base32 characters (50 bits). The contracts task (L1) fitted the layout; it is in
`src/engine/debugLink/pairing/code.ts`.

## Decision

We will have a room code name its rendezvous.

- **A LAN room code** (first character `M`–`Y`) holds:
  - the rendezvous's private IPv4 address (its last two octets, completed from the joiner's own networks as an
    address code's are);
  - a port index into a fixed list (`RENDEZVOUS_PORTS`: 7790–7799 for native Myco apps, 3000 for the dev server,
    8080 for an export's `serve.mjs`; 22 slots, 12 used);
  - an 8-bit room and a 20-bit token.
- **A hosted room code** (first character `Z`) holds a 15-bit room and a 30-bit token. It means the rendezvous
  configured in Preferences (tools) and `game.json` `debug.rendezvous` (games). Without one configured, the code is
  refused with a message saying so. No public rendezvous is run (owner, O3).
- **Who makes the room:** the waiting side opens a room on a rendezvous it can reach. That's its own server (an http
  page uses its origin: the dev server or `serve.mjs`), a native Myco app's listener, or the hosted one. It shows the
  code for that room. The joining side reads the rendezvous from the code.
- **Token strength:** a LAN room code's token is 20 bits. Codes are single use and expire in 5 minutes, and the
  rendezvous and the token gate lock after 5 wrong tries a minute, so a guesser gets about 25 tries at a million
  values.

## Alternatives considered

- **Room and token only, with each side's rendezvous configured.** Simple codes, but two pages from different servers
  never meet unless someone configures a shared rendezvous by hand.
- **A longer code with a full address and port.** About 15 characters; 0403 settled on 10.
- **Always the hosted rendezvous for room codes.** No public one is run (O3), so LAN pairs between pages would need
  the owner to run one.

## Consequences

**Positive**
- Every page ↔ page pair on one network can pair by code, as long as one of their servers (or any native Myco app)
  can host the room.

**Negative / costs**
- A LAN room code's token is 20 bits, not 30.
- The rendezvous must be on one of 12 known ports.

## Deprecates

Nothing.

## Open questions

None.

## References

`src/engine/debugLink/pairing/code.ts` (layout), `docs/plans/2026-11-debug-link-pairing-waves.md` §11 (O7), §12 (finding 5).
