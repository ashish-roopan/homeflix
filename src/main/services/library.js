'use strict';
// Orchestrates scanning the folder, reconciling with library.json, and
// enriching entries from TMDB (with a small concurrency limit).
//
// Entries in lib.movies are individual video files: kind 'movie' or 'episode'.
// Episodes point at a show record in lib.shows (keyed by normalised title),
// which carries the TMDB TV metadata and per-season episode details.
//
// Robustness rules:
//  - a folder that can't be read never deletes anything (drive unplugged, renamed)
//  - a file whose size/mtime changes keeps its metadata (downloads in progress)
//  - ids are stable across ".part" -> ".mkv"; same-size renames carry data over
//  - network failures leave entries pending and retry later

const crypto = require('crypto');
const path = require('path');
const fsp = require('fs/promises');
const { scanDirectory, watchDirectory } = require('./scanner');
const { parseMediaPath, parseMoviePath, stripPartialSuffix, PARSER_VERSION } = require('./parser');
const { METADATA_VERSION } = require('./tmdb');

const CONCURRENCY = 4;
// The user's size threshold is for movies (skips samples, trailers, clips). Episodes are legitimately
// small (a 720p episode is 100-250 MB), so they only need to clear this floor.
const EPISODE_MIN_MB = 30;
const DOWNLOADING_MTIME_MS = 2 * 60 * 1000; // modified in the last 2 min => probably still being written
const FOLLOWUP_SCAN_MS = 90 * 1000;
const PERIODIC_SCAN_MS = 10 * 60 * 1000;
const NETWORK_RETRY_MS = 60 * 1000;
const UPDATE_THROTTLE_MS = 2000;
const PROGRESS_THROTTLE_MS = 250;
const TMDB_IMG = 'https://image.tmdb.org/t/p';

class LibraryService {
  /**
   * @param {import('./store').Store} store
   * @param {import('./tmdb').TmdbClient} tmdb
   * @param {(channel:string, payload:any)=>void} emit  send to renderer
   */
  constructor(store, tmdb, emit) {
    this.store = store;
    this.tmdb = tmdb;
    this.emit = emit;
    this._scanning = null;
    this._enriching = null;
    this._rescanQueued = null;
    this._unwatch = null;
    this._timers = { followup: null, periodic: null, retry: null, update: null, progress: null };
    this._dirtyIds = new Set();
    this._dirtyShows = new Set();
    this._lastProgress = 0;
    this.state = { folderMissing: false, failedDirs: [], lastError: null, lastScanAt: null, scanning: false };
    this._lastProgressPayload = { phase: 'idle', done: 0, total: 0, current: '' };
  }

  get library() {
    const lib = this.store.getLibrary();
    if (!lib.shows) lib.shows = {};
    return lib;
  }

  // ------------------------------------------------------------------ scanning

  /** Full scan. If one is running, remembers to run once more afterwards. */
  scan({ force = false } = {}) {
    if (this._scanning) {
      this._rescanQueued = { force: Boolean(force || (this._rescanQueued && this._rescanQueued.force)) };
      return this._scanning;
    }
    this._scanning = this._doScan(force)
      .catch((err) => {
        console.error('[library] scan failed', err);
        this.state.lastError = err.message;
        this._progress({ phase: 'idle', error: 'SCAN_FAILED', message: err.message });
        return this.publicLibrary();
      })
      .finally(() => {
        this._scanning = null;
        if (this._rescanQueued) {
          const q = this._rescanQueued;
          this._rescanQueued = null;
          setTimeout(() => this.scan(q), 50);
        }
      });
    return this._scanning;
  }

  async _doScan(force) {
    const settings = this.store.getSettings();
    const lib = this.library;
    if (!settings.moviesDir) return this.publicLibrary();
    this.state.scanning = true;
    this._progress({ phase: 'scanning', done: 0, total: 0, current: '' }, true);

    let scan;
    try {
      scan = await scanDirectory(settings.moviesDir, { minFileSizeMB: Math.min(Number(settings.minFileSizeMB) || 0, EPISODE_MIN_MB) });
    } catch (err) {
      if (err.code === 'FOLDER_MISSING') {
        // Do NOT touch the library: the drive may simply be unplugged.
        this.state.folderMissing = true;
        this.state.scanning = false;
        this._progress({ phase: 'idle', done: 0, total: 0, current: '', error: 'FOLDER_MISSING', dir: settings.moviesDir }, true);
        this._emitChanged();
        return this.publicLibrary();
      }
      throw err;
    }
    this.state.folderMissing = false;
    this.state.failedDirs = scan.failedDirs;
    const root = path.resolve(settings.moviesDir);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    let idsChanged = false;
    let followupNeeded = false;

    // Group by canonical id so "X.mkv" and "X.mkv.part" collapse; prefer the complete file.
    const byId = new Map();
    for (const f of scan.files) {
      const id = idFor(f.path);
      const cur = byId.get(id);
      if (!cur || (cur.partial && !f.partial) || (cur.partial === f.partial && f.size > cur.size)) byId.set(id, f);
    }

    // Apply the movie size threshold now that we know what each small file is. Parses are cached
    // for the entry-creation loop below.
    const parsed = new Map();
    const parseOf = (id, f) => {
      if (!parsed.has(id)) parsed.set(id, parseMediaPath(f.path, root));
      return parsed.get(id);
    };
    const minMovieBytes = Math.max(0, Number(settings.minFileSizeMB) || 0) * 1024 * 1024;
    for (const [id, f] of byId) {
      if (f.partial || f.size >= minMovieBytes) continue;
      const existing = lib.movies[id];
      const kind = existing && existing.parserVersion === PARSER_VERSION && !existing.manualMatch ? existing.kind : parseOf(id, f).kind;
      if (kind !== 'episode') byId.delete(id); // too small for a movie: treated as absent
    }

    const newFiles = [];
    for (const [id, f] of byId) {
      const existing = lib.movies[id];
      if (existing) {
        const sizeChanged = existing.size !== f.size;
        const recentlyWritten = now - f.mtimeMs < DOWNLOADING_MTIME_MS;
        existing.path = f.path;
        existing.fileName = path.basename(f.path);
        existing.size = f.size;
        existing.mtimeMs = f.mtimeMs;
        existing.partial = f.partial;
        // Downloading = partial suffix, or the size moved since last scan, or it was
        // downloading and is still being written to. A stable size clears the flag.
        existing.downloading = f.partial || sizeChanged || (Boolean(existing.downloading) && recentlyWritten);
        if (recentlyWritten) followupNeeded = true;
        existing.missing = false;
        if (!existing.kind) existing.kind = 'movie';
        if (existing.parserVersion !== PARSER_VERSION && !existing.manualMatch) {
          this._applyParse(existing, parseOf(id, f), { reparse: true });
          idsChanged = true; // kind may have changed
        }
        if (force && existing.status === 'unmatched' && !existing.manualMatch) existing.status = 'pending';
        this._dirtyIds.add(id);
        continue;
      }
      newFiles.push({ id, f });
    }

    // Entries no longer present.
    const gone = [];
    for (const [id, m] of Object.entries(lib.movies)) {
      if (byId.has(id)) continue;
      const p = path.resolve(m.path);
      if (!p.startsWith(root + path.sep)) {
        delete lib.movies[id]; // belonged to a previous folder
        this.store.setPlayback(id, null);
        idsChanged = true;
        continue;
      }
      if (scan.failedDirs.some((d) => p.startsWith(d + path.sep))) {
        m.missing = true; // directory unreadable right now; keep the entry
        this._dirtyIds.add(id);
        continue;
      }
      gone.push(m);
    }

    // Create new entries, carrying data over from a vanished same-size file in the same folder (rename).
    for (const { id, f } of newFiles) {
      const candidates = gone.filter((g) => !g.partial && g.size === f.size && path.dirname(g.path) === path.dirname(f.path));
      const carry = candidates.length === 1 ? candidates[0] : null;
      // A brand-new file may still be downloading; we can't tell until the next scan
      // shows its size moved, so schedule a follow-up instead of guessing.
      if (now - f.mtimeMs < DOWNLOADING_MTIME_MS) followupNeeded = true;
      const entry = {
        id,
        path: f.path,
        fileName: path.basename(f.path),
        size: f.size,
        mtimeMs: f.mtimeMs,
        partial: f.partial,
        downloading: f.partial,
        missing: false,
        kind: 'movie',
        parsed: { title: '', year: null, languages: [] },
        parserVersion: PARSER_VERSION,
        status: 'pending',
        tmdb: null,
        posterFile: null,
        backdropFile: null,
        addedAt: carry ? carry.addedAt : nowIso,
        manualMatch: false,
      };
      this._applyParse(entry, parseOf(id, f), { reparse: false });
      if (carry && carry.kind === entry.kind) {
        if (entry.kind === 'movie' && carry.tmdb) {
          entry.tmdb = carry.tmdb;
          entry.posterFile = carry.posterFile;
          entry.backdropFile = carry.backdropFile;
          entry.status = 'matched';
          entry.manualMatch = Boolean(carry.manualMatch);
        }
        this.store.movePlayback(carry.id, id);
        delete lib.movies[carry.id];
        gone.splice(gone.indexOf(carry), 1);
      }
      lib.movies[id] = entry;
      idsChanged = true;
    }
    for (const g of gone) {
      delete lib.movies[g.id];
      this.store.setPlayback(g.id, null);
      idsChanged = true;
    }

    if (this._demoteLoneEpisodes(root)) idsChanged = true;
    if (this._reconcileShows(force)) idsChanged = true;

    this.state.lastScanAt = nowIso;
    this.state.scanning = false;
    await this.store.saveLibrary(lib);
    if (idsChanged) this._emitChanged();
    else this._flushUpdates(true);

    this._scheduleFollowup(followupNeeded);
    await this.enrichPending();
    return this.publicLibrary();
  }

  /** Write a parse result onto an entry (movie or episode). */
  _applyParse(entry, parsed, { reparse }) {
    const wasKind = entry.kind || 'movie';
    const prev = entry.parsed || {};
    if (parsed.kind === 'episode') {
      // Group by the show folder when the path has one ("TV SERIES/DEMON SLAYER/..."), else by parsed title.
      const showKey = showKeyFor(parsed.groupTitle || parsed.show.title);
      const changed = wasKind !== 'episode' || prev.title !== parsed.show.title || prev.season !== parsed.season || prev.episode !== parsed.episode || entry.showKey !== showKey;
      entry.kind = 'episode';
      entry.showKey = showKey;
      entry.parsed = {
        title: parsed.show.title,
        groupTitle: parsed.groupTitle || null,
        year: parsed.show.year,
        languages: parsed.languages || [],
        season: parsed.season,
        episode: parsed.episode,
        episodeEnd: parsed.episodeEnd || null,
        episodeTitle: parsed.episodeTitle || null,
        weak: Boolean(parsed.weak),
      };
      entry.parserVersion = PARSER_VERSION;
      if (changed) {
        entry.tmdb = null;
        entry.posterFile = null;
        entry.backdropFile = null;
        if (!entry.manualMatch) entry.status = 'pending';
      }
      return;
    }
    // movie
    const changed = wasKind !== 'movie' || prev.title !== parsed.title || prev.year !== parsed.year;
    entry.kind = 'movie';
    delete entry.showKey;
    entry.parsed = { title: parsed.title, year: parsed.year, languages: parsed.languages || [] };
    entry.parserVersion = PARSER_VERSION;
    if (changed && !entry.manualMatch) {
      if (reparse && entry.status === 'matched' && wasKind === 'movie') {
        // Old parse produced a match; re-check only if the old parse looked like junk.
        if (/^www\b|\.(com|net|org)\b/i.test(prev.title || '')) entry.status = 'pending';
      } else {
        entry.status = 'pending';
        entry.tmdb = null;
      }
    }
  }

  /**
   * "Movie Name (2021)/Movie Name - 01.mkv" parses as a weak episode. If a show
   * consists of a single weak episode and nothing else, it is a movie after all.
   */
  _demoteLoneEpisodes(root) {
    const lib = this.library;
    const byShow = new Map();
    for (const m of Object.values(lib.movies)) {
      if (m.kind !== 'episode') continue;
      if (!byShow.has(m.showKey)) byShow.set(m.showKey, []);
      byShow.get(m.showKey).push(m);
    }
    let changed = false;
    for (const list of byShow.values()) {
      if (list.length === 1 && list[0].parsed.weak && !list[0].manualMatch) {
        const m = list[0];
        this._applyParse(m, { kind: 'movie', ...parseMoviePath(m.path, root) }, { reparse: false });
        this._dirtyIds.add(m.id);
        changed = true;
      }
    }
    return changed;
  }

  /** Create show records for episodes, drop show records nobody references. */
  _reconcileShows(force) {
    const lib = this.library;
    const referenced = new Set();
    const titles = new Map(); // showKey -> Map(title -> count), to pick the commonest title for unmatched shows
    const nowIso = new Date().toISOString();
    let changed = false;
    for (const m of Object.values(lib.movies)) {
      if (m.kind !== 'episode') continue;
      referenced.add(m.showKey);
      if (m.parsed.title) {
        if (!titles.has(m.showKey)) titles.set(m.showKey, new Map());
        const t = titles.get(m.showKey);
        t.set(m.parsed.title, (t.get(m.parsed.title) || 0) + 1);
      }
      let show = lib.shows[m.showKey];
      if (!show) {
        show = lib.shows[m.showKey] = {
          key: m.showKey,
          title: m.parsed.title,
          year: m.parsed.year || null,
          tmdb: null,
          posterFile: null,
          backdropFile: null,
          seasons: {},
          status: 'pending',
          manualMatch: false,
          addedAt: nowIso,
        };
        changed = true;
      } else if (!show.year && m.parsed.year) {
        show.year = m.parsed.year;
      }
      if (force && show.status === 'unmatched' && !show.manualMatch) show.status = 'pending';
      // Episodes inherit the show's match state.
      if (show.status === 'matched' && m.status !== 'matched') {
        m.status = 'matched';
        this._dirtyIds.add(m.id);
      } else if (show.status === 'pending' && m.status !== 'pending') {
        m.status = 'pending';
      }
    }
    for (const key of Object.keys(lib.shows)) {
      if (!referenced.has(key)) {
        delete lib.shows[key];
        changed = true;
        continue;
      }
      // Not matched yet: search with the title most of the files agree on (files in one folder are
      // often named by different release groups; a single odd file must not pick the search term).
      const show = lib.shows[key];
      const counts = titles.get(key);
      if (show.status !== 'matched' && !show.manualMatch && counts) {
        const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
        if (best && show.title !== best) {
          show.title = best;
          changed = true;
        }
      }
    }
    return changed;
  }

  /**
   * Two show records that resolved to the same TMDB show (different folder or release naming for
   * different seasons) become one card: episodes are re-keyed onto the surviving record.
   */
  _mergeDuplicateShows() {
    const lib = this.library;
    const byTmdb = new Map();
    let changed = false;
    for (const show of Object.values(lib.shows)) {
      if (show.status !== 'matched' || !show.tmdb) continue;
      const keep = byTmdb.get(show.tmdb.id);
      if (!keep) {
        byTmdb.set(show.tmdb.id, show);
        continue;
      }
      const [into, from] = show.manualMatch && !keep.manualMatch ? [show, keep] : [keep, show];
      for (const m of Object.values(lib.movies)) {
        if (m.kind === 'episode' && m.showKey === from.key) {
          m.showKey = into.key;
          this._dirtyIds.add(m.id);
        }
      }
      for (const [n, season] of Object.entries(from.seasons || {})) if (!into.seasons[n]) into.seasons[n] = season;
      into.manualMatch = into.manualMatch || from.manualMatch;
      if (from.addedAt && (!into.addedAt || from.addedAt < into.addedAt)) into.addedAt = from.addedAt;
      delete lib.shows[from.key];
      byTmdb.set(show.tmdb.id, into);
      this._dirtyShows.add(into.key);
      changed = true;
    }
    return changed;
  }

  // --------------------------------------------------------------- enrichment

  /** Enrich every pending entry. Single-flight: concurrent callers share one pass. */
  enrichPending() {
    if (this._enriching) return this._enriching;
    this._enriching = this._enrichPending().finally(() => {
      this._enriching = null;
    });
    return this._enriching;
  }

  /** Build the work list: movies to look up, shows to look up / extend with new seasons. */
  _pendingTasks() {
    const lib = this.library;
    const tasks = [];
    const showsSeen = new Set();
    for (const m of Object.values(lib.movies)) {
      if (m.missing) continue;
      if (m.kind === 'episode') {
        if (showsSeen.has(m.showKey)) continue;
        const show = lib.shows[m.showKey];
        if (!show) continue;
        const eps = Object.values(lib.movies).filter((e) => e.kind === 'episode' && e.showKey === m.showKey && !e.missing);
        const needsShow = show.status === 'pending' || (m.status === 'pending' && show.status !== 'unmatched');
        const missingSeasons = show.tmdb ? [...new Set(eps.map((e) => e.parsed.season))].filter((n) => !show.seasons[n]) : [];
        const stale = show.tmdb && (show.tmdb.metadataVersion || 1) < METADATA_VERSION;
        if (needsShow || missingSeasons.length || stale) {
          showsSeen.add(m.showKey);
          tasks.push({ type: 'show', show, episodes: eps, label: show.title });
        }
      } else if (m.status === 'pending' || needsDetailsRefresh(m)) {
        tasks.push({ type: 'movie', movie: m, label: m.parsed.title });
      }
    }
    return tasks;
  }

  async _enrichPending() {
    const lib = this.library;
    const tasks = this._pendingTasks();
    if (!tasks.length) {
      this._progress({ phase: 'idle', done: 0, total: 0, current: '' }, true);
      return;
    }
    if (!this.tmdb.hasKey) {
      for (const t of tasks) {
        if (t.type === 'movie') {
          if (t.movie.status === 'pending') t.movie.status = 'unmatched';
          this._dirtyIds.add(t.movie.id);
        } else {
          if (t.show.status === 'pending') t.show.status = 'unmatched';
          for (const e of t.episodes) {
            if (e.status === 'pending') e.status = 'unmatched';
            this._dirtyIds.add(e.id);
          }
          this._dirtyShows.add(t.show.key);
        }
      }
      await this.store.saveLibrary(lib);
      this._progress({ phase: 'idle', done: 0, total: 0, current: '', error: 'NO_API_KEY' }, true);
      this._flushUpdates(true);
      return;
    }

    let done = 0;
    let fatal = null;
    const total = tasks.length;
    this._progress({ phase: 'matching', done, total, current: '' }, true);

    const queue = [...tasks];
    const worker = async () => {
      while (queue.length && !fatal) {
        const t = queue.shift();
        this._progress({ phase: 'matching', done, total, current: t.label });
        try {
          if (t.type === 'movie') await this._enrichMovie(t.movie);
          else await this._enrichShow(t.show, t.episodes);
        } catch (err) {
          const kind = err.kind || 'UNKNOWN';
          if (kind === 'NETWORK') {
            fatal = 'TMDB_UNREACHABLE';
            // leave pending so it is retried later
          } else if (kind === 'INVALID_API_KEY' || kind === 'NO_API_KEY') {
            fatal = kind;
            this._markUnmatched(t);
          } else {
            console.warn('[library] enrich failed for', t.label, err.message);
            this._markUnmatched(t);
          }
        }
        done++;
        if (t.type === 'movie') this._dirtyIds.add(t.movie.id);
        else {
          this._dirtyShows.add(t.show.key);
          for (const e of t.episodes) this._dirtyIds.add(e.id);
        }
        if (done % 5 === 0) this.store.saveLibrarySoon();
        this._flushUpdates(false);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
    const merged = this._mergeDuplicateShows();
    await this.store.saveLibrary(lib);
    if (done > 0 || merged) this._emitChanged();
    else this._flushUpdates(true);
    this._progress({ phase: 'idle', done, total, current: '', error: fatal || undefined }, true);
    if (fatal === 'TMDB_UNREACHABLE') this._scheduleRetry();
  }

  _markUnmatched(task) {
    if (task.type === 'movie') {
      const m = task.movie;
      if (m.status === 'matched') m.tmdb.metadataVersion = METADATA_VERSION; // refresh failed: don't retry forever
      else m.status = 'unmatched';
    } else {
      const show = task.show;
      if (show.status === 'matched' && show.tmdb) {
        show.tmdb.metadataVersion = METADATA_VERSION;
        for (const n of new Set(task.episodes.map((e) => e.parsed.season))) {
          if (!show.seasons[n]) show.seasons[n] = { number: n, name: `Season ${n}`, episodes: {}, failed: true };
        }
      } else {
        show.status = 'unmatched';
        for (const e of task.episodes) e.status = 'unmatched';
      }
    }
  }

  async _enrichMovie(movie) {
    if (movie.status === 'matched' && movie.tmdb) {
      // Already matched, only the details schema is stale: refresh without searching.
      const d = await this.tmdb.details(movie.tmdb.id);
      movie.tmdb = { ...movie.tmdb, ...d };
      return;
    }
    const hit = await this.tmdb.findBest(movie.parsed.title, movie.parsed.year);
    if (!hit) {
      movie.status = 'unmatched';
      movie.tmdb = null;
      return;
    }
    await this._applyTmdbId(movie, hit.id);
  }

  async _applyTmdbId(movie, tmdbId) {
    const d = await this.tmdb.details(tmdbId);
    const [posterFile, backdropFile] = await Promise.all([
      this.tmdb.downloadImage(d.posterPath, 'w500', this.store.postersDir, String(d.id)),
      this.tmdb.downloadImage(d.backdropPath, 'w1280', this.store.backdropsDir, String(d.id)),
    ]);
    movie.tmdb = d;
    movie.posterFile = posterFile;
    movie.backdropFile = backdropFile;
    movie.status = 'matched';
  }

  /** Look the show up once, then fetch details for every season we have files for. */
  async _enrichShow(show, episodes) {
    if (!show.tmdb || show.status !== 'matched') {
      const hit = await this.tmdb.findBestTv(show.title, show.year);
      if (!hit) {
        show.status = 'unmatched';
        for (const e of episodes) e.status = 'unmatched';
        return;
      }
      await this._applyTvId(show, hit.id, episodes);
      return;
    }
    if ((show.tmdb.metadataVersion || 1) < METADATA_VERSION) {
      show.tmdb = { ...show.tmdb, ...(await this.tmdb.tvDetails(show.tmdb.id)) };
    }
    await this._fetchSeasons(show, episodes);
    for (const e of episodes) e.status = 'matched';
  }

  async _applyTvId(show, tvId, episodes) {
    const d = await this.tmdb.tvDetails(tvId);
    const [posterFile, backdropFile] = await Promise.all([
      this.tmdb.downloadImage(d.posterPath, 'w500', this.store.postersDir, `tv${d.id}`),
      this.tmdb.downloadImage(d.backdropPath, 'w1280', this.store.backdropsDir, `tv${d.id}`),
    ]);
    show.tmdb = d;
    show.posterFile = posterFile;
    show.backdropFile = backdropFile;
    show.seasons = {};
    show.status = 'matched';
    await this._fetchSeasons(show, episodes);
    for (const e of episodes) e.status = 'matched';
  }

  async _fetchSeasons(show, episodes) {
    const wanted = [...new Set(episodes.map((e) => e.parsed.season))].filter((n) => Number.isInteger(n) && !show.seasons[n]);
    for (const n of wanted) {
      try {
        show.seasons[n] = await this.tmdb.seasonDetails(show.tmdb.id, n);
      } catch (err) {
        if (err.kind === 'NETWORK') throw err;
        // Season doesn't exist on TMDB (numbering differs): keep a stub so we don't retry forever.
        show.seasons[n] = { number: n, name: `Season ${n}`, overview: '', posterPath: null, airDate: null, episodes: {}, failed: true };
      }
    }
  }

  /** User picked the correct TMDB entry for a movie. */
  async fixMatch(movieId, tmdbId) {
    const movie = this.store.getMovie(movieId);
    if (!movie) throw new Error('Unknown movie');
    if (movie.kind === 'episode') return this.fixMatchShow(movie.showKey, tmdbId);
    await this._applyTmdbId(movie, tmdbId);
    movie.manualMatch = true;
    await this.store.saveLibrary();
    this._dirtyIds.add(movie.id);
    this._flushUpdates(true);
    return this.toPublic(movie);
  }

  /** User picked the correct TMDB TV entry for a show. */
  async fixMatchShow(showKey, tvId) {
    const lib = this.library;
    const show = lib.shows[showKey];
    if (!show) throw new Error('Unknown show');
    const episodes = Object.values(lib.movies).filter((e) => e.kind === 'episode' && e.showKey === showKey);
    await this._applyTvId(show, tvId, episodes);
    show.manualMatch = true;
    // The user may have pointed this at a show we already have under another folder: merge them.
    this._mergeDuplicateShows();
    const survivor = lib.shows[showKey] || Object.values(lib.shows).find((s) => s.tmdb && s.tmdb.id === tvId) || show;
    await this.store.saveLibrary();
    this._dirtyShows.add(survivor.key);
    for (const e of episodes) this._dirtyIds.add(e.id);
    this._emitChanged();
    return this.publicShow(survivor);
  }

  retryPending() {
    return this.scan({ force: false });
  }

  // ----------------------------------------------------------------- playback

  savePosition(movieId, position, duration) {
    const movie = this.store.getMovie(movieId);
    if (!movie) return null;
    const pos = Math.max(0, Number(position) || 0);
    const dur = Math.max(0, Number(duration) || 0);
    if (!Number.isFinite(pos) || !Number.isFinite(dur)) return null;
    // A file still downloading "ends" early; never mark it finished.
    const finished = !movie.downloading && dur > 0 && pos / dur > 0.95;
    const value = finished
      ? { position: 0, duration: dur, lastPlayedAt: new Date().toISOString(), finished: true }
      : { position: pos, duration: dur, lastPlayedAt: new Date().toISOString(), finished: false };
    this.store.setPlayback(movieId, value);
    this._dirtyIds.add(movieId);
    if (movie.kind === 'episode') this._dirtyShows.add(movie.showKey);
    this._flushUpdates(false);
    return value;
  }

  /** Is the file still there? Used before playing. */
  async checkFile(movieId) {
    const movie = this.store.getMovie(movieId);
    if (!movie) return { ok: false, code: 'UNKNOWN' };
    try {
      const st = await fsp.stat(movie.path);
      if (movie.missing) {
        movie.missing = false;
        this._dirtyIds.add(movieId);
        this._flushUpdates(true);
      }
      return { ok: true, size: st.size };
    } catch (err) {
      movie.missing = true;
      this._dirtyIds.add(movieId);
      this._flushUpdates(true);
      this.scan().catch(() => {});
      return { ok: false, code: err.code || 'ERROR' };
    }
  }

  // ------------------------------------------------------------------ watching

  /** Start/replace the folder watcher and periodic rescan according to current settings. */
  refreshWatcher() {
    if (this._unwatch) this._unwatch();
    this._unwatch = null;
    clearInterval(this._timers.periodic);
    const { moviesDir } = this.store.getSettings();
    if (!moviesDir) return;
    this._unwatch = watchDirectory(moviesDir, () => {
      this.scan().catch(() => {});
    });
    this._timers.periodic = setInterval(() => this.scan().catch(() => {}), PERIODIC_SCAN_MS);
  }

  /** Called when the window regains focus: cheap chance to catch up. */
  onFocus() {
    const stale = !this.state.lastScanAt || Date.now() - Date.parse(this.state.lastScanAt) > 60 * 1000;
    if (stale || this.state.folderMissing) this.scan().catch(() => {});
    else if (this._pendingTasks().length) this.enrichPending().catch(() => {});
  }

  _scheduleFollowup(force = false) {
    clearTimeout(this._timers.followup);
    if (force || Object.values(this.library.movies).some((m) => m.downloading)) {
      this._timers.followup = setTimeout(() => this.scan().catch(() => {}), FOLLOWUP_SCAN_MS);
    }
  }

  _scheduleRetry() {
    clearTimeout(this._timers.retry);
    this._timers.retry = setTimeout(() => this.enrichPending().catch(() => {}), NETWORK_RETRY_MS);
  }

  dispose() {
    if (this._unwatch) this._unwatch();
    for (const t of Object.values(this._timers)) {
      clearTimeout(t);
      clearInterval(t);
    }
  }

  // ------------------------------------------------------------------ emitting

  _progress(payload, immediate = false) {
    const p = { ...this._lastProgressPayload, ...payload };
    if (!('error' in payload)) delete p.error;
    if (!('dir' in payload)) delete p.dir;
    this._lastProgressPayload = p;
    const now = Date.now();
    if (immediate || now - this._lastProgress > PROGRESS_THROTTLE_MS) {
      clearTimeout(this._timers.progress);
      this._timers.progress = null;
      this._lastProgress = now;
      this.emit('library:progress', p);
    } else if (!this._timers.progress) {
      this._timers.progress = setTimeout(() => {
        this._timers.progress = null;
        this._lastProgress = Date.now();
        this.emit('library:progress', this._lastProgressPayload);
      }, PROGRESS_THROTTLE_MS);
    }
  }

  /** Emit changed movies/shows (throttled). */
  _flushUpdates(immediate) {
    const send = () => {
      clearTimeout(this._timers.update);
      this._timers.update = null;
      if (!this._dirtyIds.size && !this._dirtyShows.size) return;
      const movies = [];
      for (const id of this._dirtyIds) {
        const m = this.store.getMovie(id);
        if (m && m.kind !== 'episode') movies.push(this.toPublic(m));
        if (m && m.kind === 'episode') this._dirtyShows.add(m.showKey);
      }
      const shows = [];
      for (const key of this._dirtyShows) {
        const sh = this.library.shows[key];
        if (sh) shows.push(this.publicShow(sh));
      }
      this._dirtyIds.clear();
      this._dirtyShows.clear();
      this.emit('library:moviesUpdated', { movies, shows });
    };
    if (immediate) send();
    else if (!this._timers.update) this._timers.update = setTimeout(send, UPDATE_THROTTLE_MS);
  }

  /** Emit the whole library (set of ids changed). */
  _emitChanged() {
    this._dirtyIds.clear();
    this._dirtyShows.clear();
    clearTimeout(this._timers.update);
    this._timers.update = null;
    this.emit('library:changed', this.publicLibrary());
  }

  /** Library shaped for the renderer. */
  publicLibrary() {
    const lib = this.library;
    return {
      version: lib.version,
      updatedAt: lib.updatedAt,
      moviesDir: this.store.getSettings().moviesDir,
      folderMissing: this.state.folderMissing,
      failedDirs: this.state.failedDirs,
      lastScanAt: this.state.lastScanAt,
      movies: Object.values(lib.movies).filter((m) => m.kind !== 'episode').map((m) => this.toPublic(m)),
      shows: Object.values(lib.shows).map((sh) => this.publicShow(sh)),
    };
  }

  toPublic(m) {
    const t = m.tmdb;
    const out = {
      id: m.id,
      kind: m.kind || 'movie',
      fileName: m.fileName,
      path: m.path,
      size: m.size,
      parsed: m.parsed,
      status: m.status,
      tmdb: t,
      posterUrl: m.posterFile ? mediaImg('posters', m.posterFile) : t && t.posterPath ? `${TMDB_IMG}/w500${t.posterPath}` : null,
      backdropUrl: m.backdropFile ? mediaImg('backdrops', m.backdropFile) : t && t.backdropPath ? `${TMDB_IMG}/w1280${t.backdropPath}` : null,
      videoUrl: `media://movie/${m.id}`,
      addedAt: m.addedAt,
      playback: this.store.getPlayback(m.id),
      manualMatch: Boolean(m.manualMatch),
      downloading: Boolean(m.downloading),
      partial: Boolean(m.partial),
      missing: Boolean(m.missing),
    };
    if (m.kind === 'episode') {
      const show = this.library.shows[m.showKey];
      const seasonInfo = show && show.seasons[m.parsed.season];
      const epInfo = seasonInfo && seasonInfo.episodes && seasonInfo.episodes[m.parsed.episode];
      out.showKey = m.showKey;
      out.showTitle = (show && show.tmdb && show.tmdb.title) || m.parsed.title;
      out.season = m.parsed.season;
      out.episode = m.parsed.episode;
      out.episodeEnd = m.parsed.episodeEnd || null;
      out.name = (epInfo && epInfo.name) || m.parsed.episodeTitle || null;
      out.overview = (epInfo && epInfo.overview) || '';
      out.stillUrl = epInfo && epInfo.stillPath ? `${TMDB_IMG}/w300${epInfo.stillPath}` : null;
      out.airDate = (epInfo && epInfo.airDate) || null;
      out.runtime = (epInfo && epInfo.runtime) || (show && show.tmdb && show.tmdb.runtime) || null;
      out.rating = (epInfo && epInfo.rating) || null;
      out.tmdb = show ? show.tmdb : null;
      out.posterUrl = show ? showPoster(show) : null;
      out.backdropUrl = show ? showBackdrop(show) : null;
    }
    return out;
  }

  publicShow(show) {
    const lib = this.library;
    const eps = Object.values(lib.movies)
      .filter((m) => m.kind === 'episode' && m.showKey === show.key)
      .map((m) => this.toPublic(m))
      .sort(episodeOrder);
    const seasonsMap = new Map();
    for (const e of eps) {
      if (!seasonsMap.has(e.season)) {
        const info = show.seasons[e.season] || {};
        seasonsMap.set(e.season, {
          number: e.season,
          name: info.name || (e.season === 0 ? 'Specials' : `Season ${e.season}`),
          overview: info.overview || '',
          airDate: info.airDate || null,
          posterUrl: info.posterPath ? `${TMDB_IMG}/w300${info.posterPath}` : null,
          episodeCount: Object.keys((info && info.episodes) || {}).length || null,
          episodes: [],
        });
      }
      seasonsMap.get(e.season).episodes.push(e);
    }
    const seasons = [...seasonsMap.values()].sort((a, b) => (a.number === 0 ? 1 : b.number === 0 ? -1 : a.number - b.number));
    const languages = [...new Set(eps.flatMap((e) => (e.parsed && e.parsed.languages) || []))];
    const t = show.tmdb;
    return {
      id: `show:${show.key}`,
      kind: 'show',
      key: show.key,
      title: (t && t.title) || show.title,
      parsed: { title: show.title, year: show.year || null, languages },
      tmdb: t,
      status: show.status,
      manualMatch: Boolean(show.manualMatch),
      posterUrl: showPoster(show),
      backdropUrl: showBackdrop(show),
      addedAt: eps.reduce((a, e) => (e.addedAt > a ? e.addedAt : a), show.addedAt || ''),
      downloading: eps.some((e) => e.downloading),
      missing: eps.length > 0 && eps.every((e) => e.missing),
      seasonCount: seasons.length,
      episodeCount: eps.length,
      seasons,
      playback: showPlayback(eps),
      fileName: eps.length ? path.dirname(eps[0].path) : '',
    };
  }
}

// ---------------------------------------------------------------- helpers

function mediaImg(kind, file) {
  return `media://img/${kind}/${encodeURIComponent(path.basename(file))}`;
}
function showPoster(show) {
  if (show.posterFile) return mediaImg('posters', show.posterFile);
  return show.tmdb && show.tmdb.posterPath ? `${TMDB_IMG}/w500${show.tmdb.posterPath}` : null;
}
function showBackdrop(show) {
  if (show.backdropFile) return mediaImg('backdrops', show.backdropFile);
  return show.tmdb && show.tmdb.backdropPath ? `${TMDB_IMG}/w1280${show.tmdb.backdropPath}` : null;
}

function episodeOrder(a, b) {
  const sa = a.season === 0 ? Infinity : a.season;
  const sb = b.season === 0 ? Infinity : b.season;
  return sa - sb || a.episode - b.episode;
}

/**
 * Aggregate playback for a show: what to play next and how far along it is.
 * - the most recently played, unfinished episode -> resume it
 * - the most recently played episode is finished -> the next one in order
 * - nothing played -> the first episode
 */
function showPlayback(eps) {
  if (!eps.length) return null;
  let last = null;
  for (const e of eps) {
    // ">=" so that on identical timestamps the later episode in order wins.
    if (e.playback && e.playback.lastPlayedAt && (!last || e.playback.lastPlayedAt >= last.playback.lastPlayedAt)) last = e;
  }
  if (!last) return { nextEpisodeId: eps[0].id, next: eps[0], started: false, position: 0, duration: 0, finished: false, lastPlayedAt: null };
  if (!last.playback.finished) {
    return { nextEpisodeId: last.id, next: last, started: true, position: last.playback.position, duration: last.playback.duration, finished: false, lastPlayedAt: last.playback.lastPlayedAt };
  }
  const idx = eps.indexOf(last);
  const next = eps[idx + 1] || null;
  return {
    nextEpisodeId: next ? next.id : null,
    next,
    started: true,
    position: 0,
    duration: 0,
    finished: !next,
    lastPlayedAt: last.playback.lastPlayedAt,
  };
}

function needsDetailsRefresh(m) {
  return m.status === 'matched' && m.tmdb && (m.tmdb.metadataVersion || 1) < METADATA_VERSION;
}

/** Stable id: hash of the path with any partial-download suffix removed. */
function idFor(absPath) {
  const dir = path.dirname(absPath);
  const base = stripPartialSuffix(path.basename(absPath));
  return crypto.createHash('sha1').update(path.join(dir, base)).digest('hex').slice(0, 20);
}

function showKeyFor(title) {
  return String(title || '').toLowerCase().replace(/\b(the|a|an)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, '-') || 'unknown';
}

module.exports = { LibraryService, idFor, showKeyFor, showPlayback };
