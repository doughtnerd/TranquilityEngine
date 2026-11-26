# Myco rendezvous

The small service two debug peers use to find each other when neither can reach a listener on the other (a room code, ADR 0403 "Rendezvous", 0404). It relays the WebRTC handshake (an offer, an answer and a few candidates: a few hundred bytes per pairing) and then both sides leave. It never carries debug traffic, and it never reads what it relays.

**No public rendezvous is run** (owner decision). Run your own, on a machine both peers can reach.

## Run it

```
npm run build:rendezvous                      # writes dist/rendezvous/rendezvous.mjs (one file, `ws` bundled in)
node dist/rendezvous/rendezvous.mjs [--host 0.0.0.0] [--port 7790] [--path /myco-rendezvous]
```

Ctrl+C stops it. Copy `rendezvous.mjs` anywhere with Node 20+; it needs nothing else.

Ports: 7790 is the standalone service's. 3000 (the dev server) and 8080 (an export's `serve.mjs`) mount the same rendezvous on their own port at `/myco-rendezvous` instead of opening another.

## Point things at it

- **Tools** (the editor, Studio): Preferences > Rendezvous URL, for example `ws://192.168.1.20:7790/myco-rendezvous`.
- **Games**: `game.json` `debug.rendezvous`, the same URL.

Use `wss://` behind a TLS proxy if a page is served over https.

## Mount it yourself

`startRendezvous(httpServer | { port, host }, path)` is exported from the bundle (`src/server/rendezvousService.ts` in source). Given an `http.Server` it answers upgrade requests at `path` and leaves every other upgrade to the server's own handlers.
