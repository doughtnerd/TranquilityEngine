# Architecture sketch: plugin diagnostics, the profiler, localisation

A sketch of ADRs [0452](../../decisions/0452-plugins-contribute-diagnostics-every-recording-is-a-capture-and-the-profiler-is-a-self-contained-module.md)
and [0451](../../decisions/0451-localisation-becomes-a-plugin-that-provides-the-engines-strings-seam.md) (revision 2) for
the owner to refine before accepting the direction. Names are provisional; the technical design (step 6) settles
them. Solid arrows are calls or data; dotted arrows are "provides" or "registers".

## 1. Today

Each kind of profiled data has its own route.

```mermaid
flowchart TB
  subgraph Build["Running game (build or editor Play)"]
    AudioRT["Audio plugin runtime<br/>capture ring, take recorder,<br/>F9/F10 triggers, take ownership"]
    AnimRT["Animation plugin runtime<br/>take extension records,<br/>'animation' topic"]
    Core["Engine core<br/>EngineTiming hook"]
    Link["Debug link session<br/>topics: 'audio', 'animation'"]
    AudioRT -->|"take.source registry"| AudioRT
    AnimRT -.->|"take.source"| AudioRT
    AudioRT --> Link
    AnimRT --> Link
  end
  subgraph Editor["Editor"]
    PlayStats["Play Stats overlay"]
    AnimDbg["Animation debugger panel"]
  end
  subgraph Studio["Audio Studio"]
    Prof["Profiler screen<br/>(audio only)"]
    Take["Take screen<br/>(audio only)"]
  end
  Core --> PlayStats
  AudioRT -.->|"registerPlayStatsCounter"| PlayStats
  AnimRT -.->|"registerPlayStatsTable"| PlayStats
  Link -->|"audio topic"| Prof
  Link -->|"audio topic"| Take
  AudioRT -->|".sporesample file"| Prof
  AnimDbg -->|"opens take files"| AudioRT
```

## 2. Proposed: the pieces

One contribution point; consumers start sources; one transport; one profiler.

```mermaid
flowchart TB
  subgraph Build["Running game (debug build)"]
    direction TB
    subgraph Sources["Diagnostics sources (push)"]
      CoreSrc["core/frames<br/>engine clock"]
      AudioSrc["myco.audio/profile (ring)<br/>myco.audio/requests (log)<br/>audio clock + sync records"]
      AnimSrc["myco.animation/…<br/>engine clock"]
    end
    Registry["Diagnostics registry<br/>ctx.diagnostics.source(name, load)<br/>loaders only"]
    Hub["Diagnostics hub<br/>starts sources while a consumer exists<br/>source table per epoch"]
    Ring["Look-back ring<br/>bounded, in the build"]
    Writer["Capture writer<br/>.sporesample (framing moved to the engine)"]
    Topic["Debug link topic 'diagnostics'"]
    Key["Record key<br/>F9 / three-finger hold"]
    Assets["Build asset index + files<br/>(files sources declare for<br/>re-execution and deep links)"]
    Assets --> Topic
    Sources -.->|"register"| Registry
    Registry --> Hub
    Sources -->|"host.write(type, payload, time)"| Hub
    Hub --> Ring
    Hub --> Topic
    Key -->|"start / stop"| Writer
    Ring --> Writer
    Writer -->|"file on the build's disk"| Disk[("recordings/")]
  end
  subgraph Editor["Editor"]
    PlayStats["Play Stats overlay<br/>(a consumer, in-process)"]
  end
  subgraph StudioApp["Audio Studio (host)"]
    direction TB
    subgraph Profiler["Profiler module (self-contained)"]
      Client["Diagnostics link client"]
      Mirror["Look-back mirror"]
      Model["Capture model, reader, worker"]
      Play["Playback (time cursor)"]
      Views["View registry"]
      AssetSet["Build asset set<br/>downloaded on connect,<br/>mounted when a capture opens"]
      Client --> AssetSet
      AssetSet --> Model
    end
    Screens["Take and Profiler screens<br/>(views on the module)"]
    HostIF["Profiler host interface<br/>open/save files, status, theme,<br/>open asset (deep links)"]
  end
  Hub --> PlayStats
  Topic <-->|"WebSocket / WebRTC"| Client
  Client --> Mirror --> Model --> Play --> Views
  Views --> Screens
  Profiler --> HostIF
  PluginViews["Plugins' diagnostics view modules<br/>(editor halves, named by plugin.json key<br/>or the catalogue table)"] -.->|"register"| Views
```

## 3. A diagnostics source

What a plugin's runtime half provides, and what it's given.

```mermaid
classDiagram
  class DiagnosticsSourceLoader {
    <<ctx.diagnostics.source(name, load)>>
    +load() Promise~DiagnosticsSource~
  }
  class DiagnosticsSource {
    +name: "plugin/source"
    +version: number
    +types: number
    +clock: "engine" | own clock name
    +retention: "ring" | "log"
    +channel: "reliable" | "unreliable"
    +start(host) SourceRun
    +deepLinks?: which fields name an asset
    +reexecute?: feed records back into an engine
  }
  class SourceHost {
    +write(type, payload, time)
    +writeClockSync(ownTime, engineFrame)
  }
  class SourceRun {
    +keyframe?()
    +request?(name, args)
    +stop()
  }
  DiagnosticsSourceLoader --> DiagnosticsSource : loads lazily
  DiagnosticsSource --> SourceHost : start(host)
  DiagnosticsSource --> SourceRun : returns
```

## 4. Clocks

Two independent clocks; derived times are fields, not clocks. The engine never reads a plugin's clock.

```mermaid
flowchart TB
  subgraph EngineClock["Engine clock (engine frame counter + real time)"]
    W1["World A time<br/>(scaled deltaTime, timeScale)"]
    W2["World B time"]
    Anim["Animation time<br/>(World's scaled or fixed step)"]
    Tile["Tile map animation time<br/>(World time × animationSpeed)"]
    W1 --> Anim
    W1 --> Tile
  end
  subgraph AudioPlugin["Audio plugin"]
    AudioClock["Audio clock<br/>audio frames, native/audio (Rust, wasm)<br/>AudioClock capability, ClockMap"]
  end
  CoreSrc["core/frames records<br/>stamped: engine frame + real time"]
  AudioSrc["audio records<br/>stamped: audio frame"]
  Sync["Clock sync records<br/>(audio frame ↔ engine frame), written by audio"]
  EngineClock --> CoreSrc
  AudioClock --> AudioSrc
  AudioClock --> Sync
  EngineClock --> Sync
  Prof["Profiler lines every source up on the engine clock"]
  CoreSrc --> Prof
  AudioSrc --> Prof
  Sync --> Prof
```

## 5. A live session, Record, and the record key

```mermaid
sequenceDiagram
  participant G as Game (debug build)
  participant H as Diagnostics hub
  participant T as Studio profiler
  T->>G: connect (debug link pairing)
  T->>H: subscribe 'diagnostics' (all sources)
  H->>H: first consumer: load and start sources, new epoch, source table
  loop every frame
    G->>H: sources push records
    H->>H: append to the look-back ring
    H-->>T: stream records (per source channel)
  end
  Note over T: live view, scroll back through the mirror
  T->>H: Record (mark span start)
  T->>H: Stop (mark span end)
  H-->>T: span's records (survives a disconnect)
  T->>T: save capture where the Studio keeps recordings
  T->>G: disconnect
  H->>H: last consumer gone: stop sources

  Note over G,H: Without a tool
  G->>H: F9 pressed: a capture consumer starts sources
  G->>H: F9 again: stop
  H->>G: write capture to the build's disk (backup rotation)
```

## 6. A capture file

```mermaid
flowchart LR
  Header["Header, 96 B<br/>(no TAKE flag)"] --> Stream
  subgraph Stream["Deflate stream"]
    META["META JSON<br/>+ source table: name, version,<br/>clock, retention, record types"]
    Recs["Records, 20 B head each<br/>type → source via the table"]
    Index["INDEX"]
    META --> Recs --> Index
  end
```

## 7. Localisation (0451)

The plugin provides `Locale`'s existing strings seam; formatting and language state stay in the engine.

```mermaid
flowchart LR
  subgraph Engine["Engine (src/engine/localisation)"]
    Locale["Locale<br/>language state, formatting (message/),<br/>t() / tHtml(), Locale.debug()"]
    Seam["LocaleStrings seam<br/>(noStrings by default)"]
    Formats["strings/ file formats,<br/>exchange/, pseudo, languages, variants"]
    Locale --> Seam
  end
  subgraph Plugin["myco.localisation"]
    RT["Runtime half<br/>ProjectStrings / BuildStrings,<br/>build files, installBuildStrings,<br/>table hot reload"]
    ED["Editor half<br/>Localisation panel,<br/>'strings' asset kind"]
  end
  RT -.->|"ctx.locale.strings(provider)"| Seam
  RT --> Formats
  ED --> Formats
  UI["UI core: :lang(), direction, fonts"] --> Locale
  Audio["Audio: Audio.language, captions"] --> Locale
  Subs["myco.subtitles"] --> Locale
  Scripts["Scripts, Svelte: Locale.t, t()"] --> Locale
  Player["Player main.ts"] -->|"direct call (first-party)"| RT
  Export["Exporter (export/strings.ts)"] -->|"direct call"| RT
```

With the plugin off, `Locale` keeps `noStrings`: `t(key)` shows the key and warns once; language, direction, fonts,
`Audio.language` and message formatting keep working.

## 8. Where the code goes

```mermaid
flowchart TB
  subgraph E["src/engine/"]
    D["diagnostics/<br/>registry, hub, capture framing,<br/>writer, reader, record key, ownership"]
    L["localisation/<br/>(unchanged but the provider code)"]
    DL["debugLink/<br/>+ 'diagnostics' topic"]
  end
  subgraph P["src/plugins/"]
    A["audio/<br/>runtime: its sources (profile, requests),<br/>re-execution; editor/diagnostics: its views"]
    AN["animation/<br/>runtime: its source; debugger reads diagnostics"]
    LO["localisation/ (new)<br/>runtime: strings provider; editor: panel"]
  end
  subgraph S["Profiler module<br/>(src/profiler/ or src/studio/profiler/: owner list 1)"]
    PM["link client, look-back mirror,<br/>capture model, worker, playback,<br/>track kit, view registry, host interface"]
  end
  subgraph ST["src/studio/"]
    SC["Take and Profiler screens,<br/>host implementation"]
  end
  A --> D
  AN --> D
  LO --> L
  SC --> PM
  A -.->|"views"| PM
```
