<script lang="ts">
  // The heads-up display (ADR 0423), on the HUD node of prefabs/hud.prefab.json. scripts/behaviors/Hud.ts works out
  // what it shows each frame and passes it in as `hud` (texts, the leaderboard, the results, the minimap's dots, bars,
  // colours and marker positions), with `on` for the "Leave the match?" dialog's buttons. Banners and the dialog are
  // shown and hidden with the "hidden" class (display: none). Dynamic texts go in the `text` attribute, which keeps their
  // runs of spaces and line breaks (text content collapses them, as in HTML).
  interface Dot { left: number; top: number; size: number; round: number; fill: string; borderWidth: number; border: string }
  interface BoardRow { team: number; rank: string; name: string; score: string; swatch: string; mine: boolean; sunk: boolean; holder: boolean }
  interface Battery { label: string; chosen: boolean; reload: string }
  interface Marker { left: number; top: number; label: string }
  interface HudState {
    clock: string;
    status: string;
    lines: string[];
    next: string;
    /** The middle's background (under the results). */
    middle: string;
    powers: string;
    hull: { label: string; width: string; fill: string; swatch: string | null };
    port: Battery;
    starboard: Battery;
    /** The controls, named with the player's own bindings for the device they last used. */
    help: string;
    board: BoardRow[];
    legend: string;
    dots: Record<"land" | "clouds" | "pickups" | "flag-dots" | "ships", Dot[]>;
    flagMarker: Marker | null;
    homeMarker: Marker | null;
    edge: { title: string; detail: string; background: string; opacity: number } | null;
    fog: string | null;
    leave: { open: boolean; canLeave: boolean; detail: string };
  }

  let { hud, on }: { hud?: HudState; on?: { leave(): void; stay(): void } } = $props();

  const LAYERS = ["land", "clouds", "pickups", "flag-dots", "ships"] as const;
</script>

{#snippet battery(id: string, b: Battery)}
  <div {id} class="battery" style:border-color={b.chosen ? "#ffd966" : "#667080"} style:opacity={b.chosen ? 1 : 0.6}>
    <span class="battery-label" text={b.label}></span>
    <div class="reload" style:width={b.reload}></div>
  </div>
{/snippet}

{#snippet marker(id: string, m: Marker | null, badge: "flag" | "home")}
  <div {id} class="marker" class:hidden={!m} style:left={m ? `${m.left}px` : null} style:top={m ? `${m.top}px` : null}>
    <div class="badge">
      {#if badge === "flag"}<img src="textures/icon_flag.png" />{:else}<span>!</span>{/if}
    </div>
    <span class="marker-label" text={m?.label ?? ""}></span>
  </div>
{/snippet}

<!-- Drawn once the script has passed what to show. -->
{#if hud && on}
<div class="hud">
  <div id="screen">
    <div id="top">
      <div id="clock-box">
        <span id="clock" text={hud.clock}></span>
      </div>
    </div>

    <!-- A line while sunk; the results (eight lines, best first) when the match ends. -->
    <div id="middle-row">
      <div id="middle" style:background-color={hud.middle}>
        <span id="status" text={hud.status}></span>
        <div id="lines">
          {#each hud.lines as text, i (i)}
            <span class="line" text={text}></span>
          {/each}
        </div>
        <span id="next" text={hud.next}></span>
      </div>
    </div>

    <div id="bottom">
      <div id="powers" class:hidden={!hud.powers}>
        <span id="powers-label" text={hud.powers}></span>
      </div>
      <div id="bars">
        {@render battery("port", hud.port)}
        <div id="hull">
          <div id="hull-swatch" style:background-color={hud.hull.swatch}></div>
          <span id="hull-label" text={hud.hull.label}></span>
          <div id="hull-bar">
            <div id="hull-fill" style:width={hud.hull.width} style:background-color={hud.hull.fill}></div>
          </div>
        </div>
        {@render battery("starboard", hud.starboard)}
      </div>
      <!-- The text attribute keeps runs of spaces and line breaks, which text content collapses, as in HTML. -->
      <span id="help" text={hud.help}></span>
    </div>
  </div>

  <div id="overlay">
    <!-- A row per captain, best first: this captain's row (.mine), sunk ships (.sunk) and the flag's holder (.holder). -->
    <div id="leaderboard">
      <span id="board-title">Captains</span>
      {#each hud.board as row (row.team)}
        <div class="board-row" class:mine={row.mine} class:sunk={row.sunk} class:holder={row.holder}>
          <span class="rank" text={row.rank}></span>
          <div class="swatch" style:background-color={row.swatch}></div>
          <span class="name" text={row.name}></span>
          <img class="flag" src="textures/icon_flag.png" />
          <span class="score" text={row.score}></span>
        </div>
      {/each}
    </div>

    <!-- The minimap: a layer of dots per kind, bottom to top. -->
    <div id="minimap">
      <div id="chart">
        {#each LAYERS as layer (layer)}
          <div id={layer} class="layer">
            {#each hud.dots[layer] as d, i (i)}
              <div class="dot" style:left={`${d.left}px`} style:top={`${d.top}px`} style:width={`${d.size}px`} style:height={`${d.size}px`} style:border-radius={`${d.round}px`} style:background-color={d.fill} style:border-width={`${d.borderWidth}px`} style:border-color={d.border}></div>
            {/each}
          </div>
        {/each}
        <div id="north">
          <span>N</span>
        </div>
      </div>
      <span id="legend" text={hud.legend}></span>
    </div>

    <!-- Markers at the screen's edge: the flag (or its holder) off screen, and the way back from outside the arena. -->
    {@render marker("flag-marker", hud.flagMarker, "flag")}
    {@render marker("home-marker", hud.homeMarker, "home")}

    <div id="edge" class:hidden={!hud.edge}>
      <div id="edge-box" class="box" style:background-color={hud.edge?.background ?? null} style:opacity={hud.edge?.opacity ?? null}>
        <span class="title" text={hud.edge?.title ?? ""}></span>
        <span class="detail" text={hud.edge?.detail ?? ""}></span>
      </div>
    </div>

    <div id="fog" class:hidden={hud.fog === null}>
      <div id="fog-box" class="box">
        <span class="title">Hidden in the fog</span>
        <span class="detail" text={hud.fog ?? ""}></span>
      </div>
    </div>
  </div>

  <!-- "Leave the match?" (the leave action: Escape, Start). While open, Keep sailing has focus. -->
  <div id="leave" class:hidden={!hud.leave.open}>
    <div id="leave-box">
      <span class="title">Leave the match?</span>
      <span class="detail" text={hud.leave.detail}></span>
      <div id="leave-buttons">
        <button id="leave-go" class:hidden={!hud.leave.canLeave} onclick={() => on.leave()}><span>Leave</span></button>
        <button id="leave-stay" onclick={() => on.stay()}><span>Keep sailing</span></button>
      </div>
      <span id="leave-hint">Esc: keep sailing</span>
    </div>
  </div>
</div>
{/if}

<style>
  /* The theme: variables on the HUD, which everything in it inherits. */
  .hud {
    --gold: rgb(100%, 90%, 60%);
    --text: rgb(95%, 93%, 85%);
    --muted: rgb(80%, 85%, 90%);
    --flag: rgb(100%, 85%, 40%);
    --danger: rgb(100%, 45%, 25%);
    --reload: rgb(95%, 75%, 30%);
    width: 100%;
    height: 100%;
  }

  /* Banners, rows and the dialog are shown and hidden with this class; display: none takes no space. */
  .hidden { display: none; }

  /* --- The screen ------------------------------------------------------------------------------ */

  #screen {
    width: 100%;
    height: 100%;
    flex-direction: column;
    justify-content: space-between;
    padding: 12px;
  }

  #top { justify-content: center; }
  #clock-box {
    width: 104px;
    height: 40px;
    justify-content: center;
    align-items: center;
    background-color: rgba(5%, 7%, 10%, 0.6);
    border-radius: 8px;
  }
  #clock { font-size: 26px; color: var(--gold); font-weight: bold; text-align: center; }

  /* The middle's background fades in under the results. */
  #middle-row, #middle, #lines, #middle span { raycast-target: false; }
  #middle-row { justify-content: center; }
  #middle, #lines { flex-direction: column; align-items: center; }
  #middle { padding: 18px; border-radius: 10px; }
  #status { font-size: 30px; color: var(--gold); font-weight: bold; text-align: center; }
  .line { font-size: 20px; color: var(--text); text-align: center; }
  #next { font-size: 18px; color: var(--muted); text-align: center; }

  #bottom { flex-direction: column; align-items: center; gap: 6px; }
  #powers {
    justify-content: center;
    padding: 6px;
    border-radius: 8px;
    background-color: rgba(5%, 7%, 10%, 0.55);
  }
  #powers-label { font-size: 17px; color: rgb(70%, 100%, 85%); text-align: center; }

  #bars { align-items: flex-end; gap: 12px; }
  /* The batteries: the chosen one's border is lit and the other dimmed. */
  .battery, #hull {
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    background-color: rgba(5%, 7%, 10%, 0.7);
    border-radius: 8px;
  }
  .battery { width: 190px; border-width: 2px; border-color: rgb(40%, 45%, 50%); }
  .battery-label { font-size: 17px; color: var(--text); text-align: center; }
  .reload { width: 100%; height: 6px; background-color: var(--reload); border-radius: 3px; }
  #hull { width: 260px; }
  #hull-swatch { width: 100%; height: 4px; background-color: white; border-radius: 2px; }
  #hull-label { font-size: 18px; color: var(--text); text-align: center; font-weight: bold; }
  #hull-bar { width: 100%; height: 14px; background-color: rgb(15%, 15%, 18%); border-radius: 4px; }
  #hull-fill { width: 100%; height: 100%; background-color: rgb(35%, 80%, 30%); border-radius: 4px; }
  #help { font-size: 14px; color: rgba(95%, 95%, 95%, 0.85); text-align: center; }

  /* --- Over the screen ------------------------------------------------------------------------- */

  #overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }

  #leaderboard {
    position: absolute;
    top: 12px;
    left: 12px;
    width: 240px;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    background-color: rgba(5%, 7%, 10%, 0.6);
    border-radius: 8px;
  }
  #board-title { font-size: 12px; color: rgba(80%, 85%, 90%, 0.85); font-weight: bold; }
  .board-row { align-items: center; gap: 6px; height: 24px; padding: 3px; border-radius: 4px; }
  .board-row.mine { background-color: rgba(100%, 85%, 40%, 0.22); }
  .board-row span { font-size: 15px; }
  .rank { color: var(--muted); width: 20px; text-align: left; }
  .board-row .swatch { width: 10px; height: 10px; border-radius: 5px; }
  .name { color: var(--text); flex-grow: 1; text-align: left; word-break: keep-all; }
  .board-row.mine .name { font-weight: bold; }
  .board-row.sunk .name { color: rgba(95%, 93%, 85%, 0.5); }
  .board-row .flag { width: 16px; height: 16px; display: none; }
  .board-row.holder .flag { display: flex; }
  .score { color: var(--gold); font-weight: bold; width: 36px; text-align: right; }

  #minimap {
    position: absolute;
    top: 12px;
    right: 12px;
    width: 176px;
    height: 196px;
    flex-direction: column;
    align-items: center;
    padding: 6px;
    gap: 2px;
    background-color: rgba(5%, 7%, 10%, 0.6);
    border-radius: 10px;
  }
  #chart {
    width: 164px;
    height: 164px;
    border-radius: 82px;
    background-color: rgba(9%, 26%, 40%, 0.9);
    border-width: 2px;
    border-color: var(--danger);
  }
  /* The chart's sea, inside its border: dots are placed in it by their top left corner. */
  .layer { position: absolute; top: 0; left: 0; width: 160px; height: 160px; raycast-target: false; }
  .dot { position: absolute; }
  #north { position: absolute; top: 2px; left: 76px; width: 12px; height: 16px; align-items: center; }
  #north span { font-size: 12px; color: rgba(100%, 100%, 100%, 0.8); font-weight: bold; }
  #legend { font-size: 12px; color: rgba(85%, 88%, 92%, 0.9); }

  .marker, .marker * { raycast-target: false; }
  .marker {
    position: absolute;
    top: 0;
    left: 0;
    width: 64px;
    height: 60px;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .badge {
    width: 36px;
    height: 36px;
    border-radius: 18px;
    background-color: rgba(5%, 7%, 10%, 0.8);
    border-width: 3px;
    align-items: center;
    justify-content: center;
  }
  #flag-marker .badge { border-color: var(--flag); }
  #flag-marker img { width: 24px; height: 24px; }
  #home-marker .badge { border-color: var(--danger); }
  #home-marker .badge span { font-size: 20px; color: var(--danger); font-weight: bold; }
  .marker-label { font-size: 13px; color: var(--text); font-weight: bold; text-align: center; }

  /* The banners: the arena's edge (its colour and pulse come from the script), and hiding in fog. */
  #edge, #fog, #edge *, #fog * { raycast-target: false; }
  #edge, #fog { position: absolute; left: 0; width: 100%; flex-direction: column; align-items: center; }
  #edge { top: 64px; }
  #fog { top: 156px; }
  .box { flex-direction: column; align-items: center; border-radius: 10px; border-width: 2px; }
  #edge-box { gap: 4px; padding: 12px; background-color: rgba(75%, 12%, 8%, 0.88); border-color: rgb(100%, 80%, 60%); }
  #edge-box .title { font-size: 28px; color: rgb(100%, 97%, 90%); font-weight: bold; text-align: center; }
  #edge-box .detail { font-size: 18px; color: rgb(100%, 92%, 85%); text-align: center; }
  #fog-box { gap: 2px; padding: 10px; background-color: rgba(55%, 60%, 66%, 0.8); border-color: rgb(90%, 93%, 96%); }
  #fog-box .title { font-size: 22px; color: white; font-weight: bold; text-align: center; }
  #fog-box .detail { font-size: 16px; color: rgb(95%, 97%, 100%); text-align: center; }

  /* --- Leave the match? ------------------------------------------------------------------------ */

  #leave {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    background-color: rgba(0, 0, 0, 0.45);
  }
  #leave-box {
    flex-direction: column;
    align-items: center;
    gap: 14px;
    padding: 24px;
    border-radius: 12px;
    background-color: rgba(7%, 10%, 14%, 0.95);
    border-width: 2px;
    border-color: var(--flag);
  }
  #leave-box .title { font-size: 30px; color: var(--gold); font-weight: bold; text-align: center; }
  #leave-box .detail { font-size: 17px; color: var(--text); text-align: center; }
  #leave-buttons { gap: 14px; }
  #leave-buttons button { width: 170px; height: 48px; border-radius: 8px; font-size: 20px; font-weight: bold; }
  #leave-go { background-color: rgb(70%, 20%, 15%); color: rgb(100%, 97%, 92%); }
  #leave-go:hover { background-color: rgb(82%, 28%, 20%); }
  #leave-go:pressed { background-color: rgb(55%, 14%, 10%); }
  #leave-stay { background-color: rgb(85%, 60%, 18%); color: rgb(10%, 7%, 3%); }
  #leave-stay:hover { background-color: rgb(95%, 70%, 26%); }
  #leave-stay:pressed { background-color: rgb(65%, 45%, 12%); }
  #leave-hint { font-size: 13px; color: rgba(80%, 85%, 90%, 0.8); text-align: center; }
</style>
