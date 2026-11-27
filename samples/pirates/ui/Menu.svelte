<script lang="ts">
  // The main menu and the room view (ADR 0068, 0423), shown by the Menu node in scenes/menu.scene.json: its
  // UIView's props are `menu` (what the lobby says, scripts/behaviors/Menu.ts fills it each frame), `fields` (the
  // name, room code and server address fields, bound both ways) and `on` (what the buttons do). Screens are shown
  // and hidden with the "hidden" class (display: none), so the scene view shows the home screen. Dynamic texts go in
  // the `text` attribute, which keeps their runs of spaces (text content collapses them, as in HTML).
  /** A seat of the room's crew: a player in their slot, or a bot filling an empty one. */
  interface Seat {
    slot: number;
    name: string;
    tag: string;
    swatch: string;
    me: boolean;
    bot: boolean;
  }

  /** What scripts/behaviors/Menu.ts reads from the lobby each frame. */
  interface MenuState {
    where: string;
    status: string;
    error: string;
    /** The screen shown: home (play, rooms, servers) or the room; null while a match plays. */
    screen: "home" | "room" | null;
    sailing: boolean;
    rooms: { code: string; label: string }[];
    showLocal: boolean;
    room: {
      title: string;
      code: string;
      seats: Seat[];
      settingsTitle: string;
      settings: { key: string; label: string; value: string }[];
      /** The host steps through the settings; the rest see them only. */
      canSet: boolean;
      results: { title: string; lines: string[] } | null;
      status: string;
      ready: boolean;
      host: boolean;
    } | null;
  }

  /** What the buttons do (the script's). */
  interface MenuActions {
    quickMatch(): void;
    practice(): void;
    createRoom(): void;
    joinCode(): void;
    joinRoom(code: string): void;
    joinServer(): void;
    local(): void;
    ready(): void;
    start(): void;
    leave(): void;
    step(key: string, by: number): void;
  }

  // Before the script passes them (and in the editor's scene view): the home screen, with fields of its own.
  const HOME: MenuState = { where: "", status: "", error: "", screen: "home", sailing: false, rooms: [], showLocal: false, room: null };
  const NOTHING = () => {};
  const IDLE: MenuActions = { quickMatch: NOTHING, practice: NOTHING, createRoom: NOTHING, joinCode: NOTHING, joinRoom: NOTHING, joinServer: NOTHING, local: NOTHING, ready: NOTHING, start: NOTHING, leave: NOTHING, step: NOTHING };
  let { menu = HOME, fields = { name: "", code: "", url: "" }, on = IDLE }: { menu?: MenuState; fields?: { name: string; code: string; url: string }; on?: MenuActions } = $props();

  let room = $derived(menu.room);
</script>

<div id="screen">
  <div id="header">
    <div id="titles">
      <span id="title">King of Pirates</span>
      <span id="subtitle">Hold the flag. Sink the rest. Rule the waves.</span>
    </div>
    <div id="connection" class="card">
      <span id="where" text={menu.where}></span>
      <span id="status" class="muted" text={menu.status}></span>
    </div>
  </div>

  <!-- Home: play now, make or join a room, or switch to a dedicated server's lobby. -->
  <div id="home" class="columns" class:hidden={menu.screen !== "home"}>
    <div id="left" class="card">
      <span class="label">Your name, captain</span>
      <input id="name" placeholder="Your name" max-length="20" bind:value={fields.name} />
      <button id="quick-match" class="primary" onclick={() => on.quickMatch()}><span>Quick Match</span></button>
      <button id="practice" class="wide" onclick={() => on.practice()}><span>Practice against bots</span></button>
      <button id="create-room" class="wide" onclick={() => on.createRoom()}><span>Create a room</span></button>
      <span class="label">Join a room by its code</span>
      <div class="row">
        <input id="code" class="grow" placeholder="ABCDE" max-length="5" bind:value={fields.code} onchange={() => (fields.code = fields.code.toUpperCase())} onsubmit={() => on.joinCode()} />
        <button id="join" onclick={() => on.joinCode()}><span>Join</span></button>
      </div>
    </div>

    <div id="right" class="card grow">
      <span class="heading">Open rooms</span>
      <div id="rooms" class="stack" class:hidden={menu.rooms.length === 0}>
        {#each menu.rooms as r (r.code)}
          <div class="room">
            <span class="room-label" text={r.label}></span>
            <button class="room-join" onclick={() => on.joinRoom(r.code)}><span>Join</span></button>
          </div>
        {/each}
      </div>
      <span id="no-rooms" class="muted" class:hidden={menu.rooms.length > 0}>No open rooms yet. Make one, or try a quick match!</span>
      <div class="grow"></div>
      <span class="heading">Play on a server</span>
      <div class="row">
        <input id="url" class="grow" placeholder="ws://localhost:7777" bind:value={fields.url} onsubmit={() => on.joinServer()} />
        <button id="connect" onclick={() => on.joinServer()}><span>Join Server</span></button>
        <button id="local" class:hidden={!menu.showLocal} onclick={() => on.local()}><span>Local</span></button>
      </div>
      <span id="server-hint" class="muted">Start one with: npm run server -- samples/pirates</span>
    </div>
  </div>

  <!-- The room: its crew (players, then the bots that fill the ships), the host's settings, results. -->
  <div id="room" class="columns" class:hidden={menu.screen !== "room"}>
    <div id="crew" class="card">
      <span id="room-title" text={room?.title ?? ""}></span>
      <span id="room-code" class="muted" text={room?.code ?? ""}></span>
      <div id="slots" class="stack">
        {#each room?.seats ?? [] as seat (seat.slot)}
          <div class="slot" class:me={seat.me} class:bot={seat.bot}>
            <div class="swatch" style:background-color={seat.swatch}></div>
            <span class="slot-name" text={seat.name}></span>
            <span class="slot-tag" text={seat.tag}></span>
          </div>
        {/each}
      </div>
    </div>

    <div id="side" class="grow">
      <div id="settings" class="card">
        <span class="heading" text={room?.settingsTitle ?? ""}></span>
        <div id="setting-rows" class="stack">
          {#each room?.settings ?? [] as s (s.key)}
            <div class="setting">
              <span class="setting-label" text={s.label}></span>
              <button class="step prev" interactable={String(!!room?.canSet)} onclick={() => on.step(s.key, -1)}><span text={"<"}></span></button>
              <span class="setting-value" text={s.value}></span>
              <button class="step next" interactable={String(!!room?.canSet)} onclick={() => on.step(s.key, 1)}><span text={">"}></span></button>
            </div>
          {/each}
        </div>
      </div>

      <div id="results" class="card" class:hidden={!room?.results}>
        <span class="heading" text={room?.results?.title ?? ""}></span>
        <div id="result-lines" class="stack">
          {#each room?.results?.lines ?? [] as text, i (i)}
            <span class="result" text={text}></span>
          {/each}
        </div>
      </div>

      <div class="grow"></div>
      <span id="room-status" text={room?.status ?? ""}></span>
      <div id="room-buttons" class="row">
        <button id="ready" class:on={!!room?.ready} onclick={() => on.ready()}><span text={room?.ready ? "Ready!" : "Ready?"}></span></button>
        <button id="start" class="primary" class:hidden={!room?.host} onclick={() => on.start()}><span>Start now</span></button>
        <button id="leave" onclick={() => on.leave()}><span>Leave</span></button>
      </div>
    </div>
  </div>

  <!-- Over everything while the match World loads. -->
  <div id="sailing" class:hidden={!menu.sailing}>
    <span>Raising the sails...</span>
  </div>

  <div id="footer">
    <!-- The text attribute keeps runs of spaces and line breaks, which text content collapses, as in HTML. -->
    <span id="help" text={"Steer with the mouse.  A / D pick a battery.  Space fires.  F drops a ghost ship's fog.  Esc leaves a match."}></span>
    <span id="error" text={menu.error}></span>
  </div>
</div>

<style>
  /* The theme: variables on the screen, which everything in it inherits. */
  #screen {
    --gold: rgb(100%, 85%, 45%);
    --text: rgb(95%, 93%, 85%);
    --text-dim: rgba(95%, 93%, 85%, 0.55);
    --muted: rgb(75%, 80%, 86%);
    --error: rgb(100%, 55%, 45%);
    --card: rgba(5%, 7%, 10%, 0.74);
    --veil: rgba(5%, 7%, 10%, 0.55);
    --field: rgba(255, 255, 255, 0.08);
    --field-border: rgba(255, 255, 255, 0.25);
    --button: rgb(13.7%, 18.8%, 24.7%);
    --button-hover: rgb(20%, 27%, 35%);
    --button-pressed: rgb(10%, 13%, 17%);
    --primary: rgb(85%, 60%, 18%);
    --primary-hover: rgb(95%, 70%, 26%);
    --primary-pressed: rgb(65%, 45%, 12%);
    --primary-text: rgb(10%, 7%, 3%);
    --ready: #3f8f4a;
    --gutter: 20px;
  }

  /* --- Layout ---------------------------------------------------------------------------------- */

  #screen {
    width: 100%;
    height: 100%;
    flex-direction: column;
    padding: 28px;
    gap: 16px;
    color: var(--text); /* text properties inherit, as on the web */
    font-size: 16px;
  }

  #header { justify-content: space-between; align-items: flex-end; }
  #titles { flex-direction: column; gap: 2px; }
  #footer { justify-content: space-between; align-items: center; }

  .columns { gap: var(--gutter); flex-grow: 1; }
  .row { gap: 10px; }
  .stack { flex-direction: column; gap: 12px; }
  .grow { flex-grow: 1; }
  /* Screens and controls are shown and hidden with this class; display: none takes no space. */
  .hidden { display: none; }

  .card {
    flex-direction: column;
    background-color: var(--card);
    border-radius: 14px;
    padding: 22px;
    gap: 12px;
  }

  /* --- Text ------------------------------------------------------------------------------------ */

  #title { font-size: 60px; font-weight: bold; color: var(--gold); }
  #subtitle { font-size: 20px; }
  .heading { font-size: 22px; font-weight: bold; color: var(--gold); }
  .label { color: var(--muted); }
  .muted { color: var(--muted); }
  #help { font-size: 15px; }
  #error { color: var(--error); font-weight: medium; }

  /* --- Controls -------------------------------------------------------------------------------- */

  input {
    font-size: 18px;
    background-color: var(--field);
    border-radius: 6px;
    border-width: 1px;
    border-color: var(--field-border);
    padding: 10px;
    height: 42px;
  }

  button {
    background-color: var(--button);
    border-radius: 8px;
    padding: 6px;
    font-size: 20px;
    font-weight: medium;
  }
  button:hover { background-color: var(--button-hover); }
  button:pressed { background-color: var(--button-pressed); }

  .primary { background-color: var(--primary); color: var(--primary-text); font-size: 24px; font-weight: bold; padding: 10px; }
  .primary:hover { background-color: var(--primary-hover); }
  .primary:pressed { background-color: var(--primary-pressed); }

  /* --- Home ------------------------------------------------------------------------------------ */

  #connection { align-items: flex-end; gap: 4px; border-radius: 10px; padding: 12px; }
  #status { font-size: 14px; }
  #left { width: 430px; }
  #quick-match { height: 60px; }
  .wide { padding: 10px; height: 50px; }
  #join { width: 110px; height: 42px; }
  #connect { width: 150px; height: 42px; }
  #local { width: 90px; height: 42px; }
  #no-rooms { font-size: 17px; }
  #server-hint { font-size: 15px; }

  .room {
    align-items: center;
    gap: 10px;
    background-color: rgba(255, 255, 255, 0.05);
    border-radius: 8px;
    padding: 8px;
  }
  .room-label { font-size: 18px; flex-grow: 1; }
  .room-join { padding: 4px; width: 90px; height: 36px; font-size: 16px; }

  /* --- The room -------------------------------------------------------------------------------- */

  #crew { width: 470px; gap: 8px; }
  #room-title { font-size: 28px; font-weight: bold; color: var(--gold); }
  #room-code { font-size: 17px; }
  #slots { gap: 8px; }

  .slot {
    align-items: center;
    gap: 12px;
    height: 38px;
    border-radius: 8px;
    padding: 8px;
    background-color: rgba(255, 255, 255, 0.04);
  }
  .slot.me { background-color: rgba(255, 255, 255, 0.12); }
  .swatch { width: 20px; height: 20px; border-radius: 10px; }
  .slot-name { font-size: 19px; flex-grow: 1; }
  .slot.bot .slot-name { color: var(--text-dim); }
  .slot-tag { font-size: 15px; font-weight: bold; color: var(--gold); }

  #side { flex-direction: column; gap: 16px; }
  #settings { gap: 10px; }
  #setting-rows { gap: 10px; }
  .setting { align-items: center; gap: 10px; }
  .setting-label { font-size: 18px; color: var(--muted); width: 150px; }
  .setting-value { font-size: 20px; font-weight: medium; width: 170px; text-align: center; }
  .step { padding: 4px; width: 44px; height: 38px; }
  /* Only the host steps through the settings: the buttons aren't interactable for the rest. */
  .step:disabled { visible: false; }

  #results { gap: 6px; }
  #result-lines { gap: 6px; }
  .result { font-size: 17px; }

  #room-status { font-size: 18px; }
  #room-buttons { gap: 12px; }
  #ready, #start, #leave { padding: 10px; height: 54px; }
  #ready { width: 150px; }
  #ready.on { background-color: var(--ready); }
  #start { width: 170px; font-size: 22px; }
  #leave { width: 120px; }

  /* --- Setting sail ---------------------------------------------------------------------------- */

  #sailing {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    justify-content: center;
    align-items: center;
    background-color: var(--veil);
    font-size: 40px;
    font-weight: bold;
    color: var(--gold);
  }
</style>
