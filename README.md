# Homeflix

A Netflix-style launcher for the movies you download. Homeflix is a small
Electron app for macOS and Windows. It watches your movies folder (default:
`~/Documents/MOVIES` on macOS, `E:\` on Windows), works out each film's title and year from the file
name, pulls the poster, backdrop, rating, runtime and overview from TMDB, and
shows everything in a Netflix-like UI with a built-in player.

## Run it

**macOS**: double-click **Homeflix.app** in `~/Applications` (Spotlight: type "Homeflix").

**Windows**: run `Homeflix.exe` from `dist\Homeflix-win32-x64\` (pin it to Start
or the taskbar from there).

From source, on either platform (needs Node.js 20 or newer):

```bash
cd ~/code/homeflix
npm install
npm start
```

Windows only: Electron's installer unzips with a native helper that needs the
Microsoft Visual C++ Redistributable. If `npm install` ends with "Cannot find
native binding", install it from <https://aka.ms/vs/17/release/vc_redist.x64.exe>
and run `npm install` again.

Rebuild the app after code changes with `npm run dist`. It packages for the
platform you run it on:

- macOS: `dist/Homeflix-darwin-arm64/Homeflix.app`. Copy it over the one in
  `~/Applications`. The bundle is unsigned, so if macOS complains on first open,
  right-click it and choose Open.
- Windows: `dist\Homeflix-win32-x64\Homeflix.exe` (a portable folder, no
  installer). SmartScreen may warn on first run because it is unsigned; choose
  "More info" then "Run anyway".

`npm run icon` regenerates `build/icon.png` and `build/icon.ico` from the
CSS artwork in `build/make-icon.js` (the `.icns` is built from the PNG with
`iconutil` on a Mac).

## First launch

If the default folder (`~/Documents/MOVIES` on macOS, `E:\` on Windows) exists it is used automatically and you land on the
home screen right away. Without a TMDB key a banner offers to add one; the app
still lists your files, just with placeholder posters.

- **TMDB API key**: free at <https://www.themoviedb.org/settings/api>
  (either the "API Key" or the "API Read Access Token" works). Paste it in
  Settings (gear icon, top right).
- **Movies folder**: change it in Settings. Sub-folders are scanned too.
- **Ignore files smaller than**: defaults to 300 MB so samples, clips and trailers are skipped.

Data lives in `~/Library/Application Support/homeflix/` on macOS and
`%APPDATA%\homeflix\` on Windows: `settings.json`, `library.json` (+ `.bak`),
`playback.json`, and `images/`. Delete the folder to start fresh.

## What it copes with

Homeflix is built for a real downloads folder, not a tidy one:

- **Messy names**: `www.5MovieRulz.bargains - Dheeram (2025) Malayalam HQ HDRip - x264 - AAC - 400MB - ESub.mkv`
  becomes *Dheeram (2025)*. Website prefixes, regional language tags, size tags,
  `-GROUP` suffixes, `[YTS.MX]` brackets, folder-per-movie layouts and numeric
  titles (*2012*, *1917*, *Blade Runner 2049*) are all handled. Run `npm test`
  to see the cases.
- **Partial downloads**: `.part`, `.crdownload`, `.!qB`, `.aria2` … files show up
  as **Downloading** cards with a poster already, and keep their identity when
  the download finishes and the suffix disappears. A leftover `.part` next to
  the finished file collapses into one card.
- **Files still being written**: a file whose size changes between scans is
  flagged Downloading and is never re-looked-up on TMDB. Follow-up scans run
  every 90 s while anything is downloading.
- **Renames**: renaming a file keeps its metadata, watched position and manual
  match (matched by size within the same folder).
- **Duplicates**: two copies of one movie show as one card with a "2 files" tag;
  the detail view lists both.
- **Other files**: subtitles, images, text, archives, `.DS_Store`, hidden and
  AppleDouble files, `Sample`/`Trailer` folders, zero-byte files and Safari
  `.download` bundles are ignored. Symlinks are not followed, so loops are impossible.
- **Unplugged drive / renamed folder**: the library is kept intact and a banner
  asks you to reconnect or choose another folder. Nothing is deleted until the
  folder is readable again and the files are really gone.
- **Unreadable sub-folders**: their movies are kept and marked *File missing*.
- **Offline / TMDB down**: lookups time out after 15 s, items stay pending, a
  banner appears, and retries happen automatically (60 s, on focus, on rescan).
- **Corrupted data files**: `library.json` is written atomically with a rolling
  backup; a damaged file is set aside and restored from `.bak`.
- **Large libraries**: tested with 1500+ files. Rows render lazily as you
  scroll, long rows get a *See all* grid, the library is written to disk at most
  every 2 s, and playback positions live in their own small file.

## TV shows

Episodes are detected from names like `S01E02`, `1x02`, `Season 1 Episode 2`,
`Show/Season 2/03 - Title.mkv`, `Show/S03/E04.mkv`, season-pack folders
(`Show.S01.1080p/…`) and anime-style `[Group] Show - 05.mkv`, in any folder
layout: all episodes in one folder, one folder per season, or nested under
category folders like `TV/Hindi/…`. Episodes group into a show card (marked
SERIES) with one TMDB lookup per show and one call per season for episode
names, stills and overviews. The show view lists seasons and episodes, shows
what's next, and the player continues to the next episode automatically
(press **N** to skip ahead). Movies in arbitrary nested subfolders are fine too.

## Recommendations

"Recommended for you" and "Because you watched …" rows are computed locally
from your watch history: genres, languages and decades of what you finished or
started (weighted by how much you watched and how recently), matched against
titles you haven't watched yet. Nothing leaves your machine.

## Playback

Built-in player: Space, ←/→ seek 10 s, ↑/↓ volume, F fullscreen, M mute, N next
episode, Esc back. Position is remembered and surfaces in **Continue watching**. Files stream
through a private `media://` protocol with Range support, so seeking works on
large files.

The player is Chromium, so H.264/VP9/AV1 video with AAC/Opus/MP3 audio plays
fine. HEVC (H.265), AC3, EAC3 and DTS usually do not. The player then shows
**Open in external player**, which hands the file to whatever the OS uses for
that type. Install [IINA](https://iina.io) or [VLC](https://www.videolan.org)
on macOS, or [VLC](https://www.videolan.org) / [MPC-HC](https://github.com/clsid2/mpc-hc)
on Windows, for those files. **Show in Finder** / **Show in Explorer** opens
the file's folder.

## Fixing a wrong match

Open the movie and use **Fix match** to search TMDB yourself; manual matches
survive rescans. Right-click the Rescan button to retry every unmatched file.

## Tests

```bash
npm test          # parser, scanner (1500-file hostile tree), library reconciliation, streaming
npm run smoke     # launches the real app 4x against a mock TMDB: cold, warm, folder missing, TMDB down
```

## Layout

```
src/main/main.js              window, media:// protocol, CSP, dev hooks
src/main/ipc.js               IPC handlers
src/main/services/store.js    settings / library / playback JSON with backup + recovery
src/main/services/scanner.js  folder walk (bounded concurrency) + self-healing fs.watch
src/main/services/parser.js   file/folder names -> movie { title, year } or episode { show, season, episode }
src/main/services/tmdb.js     TMDB client with timeouts + error kinds
src/main/services/library.js  scan/reconcile/enrich orchestration
src/main/services/stream.js   Range-capable file responses
src/preload/preload.js        window.api bridge
src/renderer/                 UI (plain HTML/CSS/JS); components/show.js is the season/episode view
build/dist.js                 npm run dist: @electron/packager options per platform
build/make-icon.js            npm run icon: renders icon.png + icon.ico
test/                         node:test suites, fixtures, mock TMDB, smoke script
```

Security: `contextIsolation` on, `nodeIntegration` off, `sandbox` on, strict
CSP, and `media://` only serves files that are in the library or the image cache.

Platform notes: the main process hides the native title bar on every platform;
macOS keeps its traffic lights, Windows/Linux get Chromium's caption buttons
overlaid top-right and the renderer pads the top bar for them (`data-platform`
on `<body>`, set from `window.api.platform`). Test fixtures create sparse files
with `fsutil` and unreadable folders with `icacls` on Windows, `chmod` elsewhere.
`npm run smoke` runs from Git Bash on Windows too.

## Dev hooks

- `MOVIE_LAUNCHER_DEVTOOLS=1 npm start` opens DevTools
  (PowerShell: `$env:MOVIE_LAUNCHER_DEVTOOLS=1; npm start`).
- `MOVIE_LAUNCHER_USER_DATA=/tmp/x` uses a throwaway data folder.
- `MOVIE_LAUNCHER_SHOT=/tmp/x.png` screenshots the window after
  `MOVIE_LAUNCHER_SHOT_DELAY` ms (default 3000) and quits; add
  `MOVIE_LAUNCHER_SCRIPT=/path.js` to run page JS first, `MOVIE_LAUNCHER_PRESCRIPT`
  to run JS at dom-ready.
- `TMDB_API_BASE` / `TMDB_IMG_BASE` point the client at `test/mock-tmdb.js`.
