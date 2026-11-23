# Sound events (replaced by playlists)

Audio events (`*.audioevent.json`, ADR 0158) were replaced by **playlists** (ADR 0343). Read [Playlists](playlists.md).

A project with old event files migrates them once: the editor and the Audio Studio offer it when the project opens, and `npm run audio:migrate -- <project folder>` does it from the command line. Each event becomes a `*.playlist.json` beside it, references in scenes, prefabs and playlists are rewritten, scripts that name an event are listed for you to fix, and the old files are kept in `.myco/migrated/`. The engine, exports and the dedicated server refuse an old event file with a message naming the migration. `AudioEventHandle` remains for one release as an alias of `AudioPlaylistHandle`.
