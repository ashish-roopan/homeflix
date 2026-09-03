'use strict';
// Persistent JSON storage under userData:
//   settings.json  – user settings
//   library.json   – scanned movies + TMDB metadata (coalesced writes, .bak kept)
//   playback.json  – playback positions (small, written often)
// Writes are atomic (temp file + fsync + rename) and serialised.

const fsp = require('fs/promises');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Windows: the movies live on the E: drive; elsewhere ~/Documents/MOVIES. Used only when no folder is set yet.
const DEFAULT_MOVIES_DIR = process.platform === 'win32' ? 'E:\\' : path.join(os.homedir(), 'Documents', 'MOVIES');

const DEFAULT_SETTINGS = {
  moviesDir: null,
  tmdbApiKey: null,
  minFileSizeMB: 300,
};

const EMPTY_LIBRARY = () => ({ version: 3, updatedAt: null, movies: {}, shows: {} });
const BACKUP_INTERVAL_MS = 10 * 60 * 1000;
const COALESCE_MS = 2000;

class Store {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.settingsPath = path.join(userDataDir, 'settings.json');
    this.libraryPath = path.join(userDataDir, 'library.json');
    this.playbackPath = path.join(userDataDir, 'playback.json');
    this.imagesDir = path.join(userDataDir, 'images');
    this.postersDir = path.join(this.imagesDir, 'posters');
    this.backdropsDir = path.join(this.imagesDir, 'backdrops');
    this._settings = null;
    this._library = null;
    this._playback = null;
    this._writeQueue = Promise.resolve();
    this._pending = new Map(); // file -> timer for coalesced writes
    this._lastBackup = new Map(); // file -> ts
    this.notices = []; // e.g. { type: 'recovered', file }
  }

  async init() {
    await fsp.mkdir(this.postersDir, { recursive: true });
    await fsp.mkdir(this.backdropsDir, { recursive: true });

    const settings = await this._readWithRecovery(this.settingsPath, {}, (v) => v && typeof v === 'object');
    this._settings = { ...DEFAULT_SETTINGS, ...sanitizeSettings(settings) };
    if (!this._settings.moviesDir && (await isDirectory(DEFAULT_MOVIES_DIR))) {
      this._settings.moviesDir = DEFAULT_MOVIES_DIR;
    }

    const lib = await this._readWithRecovery(this.libraryPath, null, (v) => v && typeof v === 'object' && v.movies && typeof v.movies === 'object');
    this._library = lib ? sanitizeLibrary(lib) : EMPTY_LIBRARY();

    const pb = await this._readWithRecovery(this.playbackPath, {}, (v) => v && typeof v === 'object');
    this._playback = pb || {};
    // Migrate v1 libraries that stored playback inline.
    for (const m of Object.values(this._library.movies)) {
      if (m.playback && !this._playback[m.id]) this._playback[m.id] = m.playback;
      delete m.playback;
    }
  }

  // ---- settings ----
  getSettings() {
    return { ...this._settings };
  }

  async saveSettings(patch) {
    this._settings = { ...this._settings, ...sanitizeSettings(patch) };
    await this._write(this.settingsPath, this._settings);
    return this.getSettings();
  }

  // ---- library ----
  getLibrary() {
    return this._library;
  }

  getMovie(id) {
    return this._library.movies[id] || null;
  }

  getShow(key) {
    return (this._library.shows || (this._library.shows = {}))[key] || null;
  }

  /** Immediate, awaited write. */
  async saveLibrary(library) {
    if (library) this._library = library;
    this._library.updatedAt = new Date().toISOString();
    this._cancelPending(this.libraryPath);
    await this._write(this.libraryPath, this._library);
    return this._library;
  }

  /** Coalesced write: many calls within COALESCE_MS produce one disk write. */
  saveLibrarySoon() {
    this._library.updatedAt = new Date().toISOString();
    this._schedule(this.libraryPath, () => this._library);
  }

  async updateMovie(id, patch) {
    const cur = this._library.movies[id];
    if (!cur) return null;
    this._library.movies[id] = { ...cur, ...patch };
    this.saveLibrarySoon();
    return this._library.movies[id];
  }

  // ---- playback ----
  getPlayback(id) {
    return this._playback[id] || null;
  }

  getAllPlayback() {
    return this._playback;
  }

  setPlayback(id, value) {
    if (value) this._playback[id] = value;
    else delete this._playback[id];
    this._schedule(this.playbackPath, () => this._playback);
    return value;
  }

  /** Re-key playback when a movie id changes (e.g. file renamed). */
  movePlayback(fromId, toId) {
    if (fromId === toId || !this._playback[fromId]) return;
    if (!this._playback[toId]) this._playback[toId] = this._playback[fromId];
    delete this._playback[fromId];
    this._schedule(this.playbackPath, () => this._playback);
  }

  /** Flush all coalesced writes. Call before quit. */
  async flush() {
    for (const [file, entry] of this._pending) {
      clearTimeout(entry.timer);
      this._pending.delete(file);
      this._write(file, entry.get());
    }
    await this._writeQueue;
  }

  // ---- internals ----
  _schedule(file, get) {
    const existing = this._pending.get(file);
    if (existing) {
      existing.get = get;
      return;
    }
    const entry = { get, timer: null };
    entry.timer = setTimeout(() => {
      this._pending.delete(file);
      this._write(file, entry.get()).catch(() => {});
    }, COALESCE_MS);
    this._pending.set(file, entry);
  }

  _cancelPending(file) {
    const e = this._pending.get(file);
    if (e) {
      clearTimeout(e.timer);
      this._pending.delete(file);
    }
  }

  // Serialise writes so concurrent saves never interleave.
  _write(file, data) {
    this._writeQueue = this._writeQueue
      .catch(() => {})
      .then(() => this._writeAtomic(file, data));
    return this._writeQueue;
  }

  async _writeAtomic(file, data) {
    // Keep a rolling backup of the previous good version (rate limited).
    const last = this._lastBackup.get(file) || 0;
    if (Date.now() - last > BACKUP_INTERVAL_MS) {
      try {
        await fsp.copyFile(file, `${file}.bak`);
        this._lastBackup.set(file, Date.now());
      } catch {
        /* no previous file yet: try again on the next write */
      }
    }
    const tmp = `${file}.${process.pid}.tmp`;
    const json = JSON.stringify(data);
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(json, 'utf8');
      await fh.sync().catch(() => {});
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, file);
  }

  /** Read JSON; on corruption keep the bad file aside and fall back to .bak. */
  async _readWithRecovery(file, fallback, validate) {
    const tryRead = async (p) => {
      const raw = await fsp.readFile(p, 'utf8');
      const v = JSON.parse(raw);
      if (validate && !validate(v)) throw new Error('invalid shape');
      return v;
    };
    try {
      return await tryRead(file);
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      console.warn(`[store] ${path.basename(file)} unreadable (${err.message}); trying backup`);
      try {
        await fsp.rename(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      try {
        const v = await tryRead(`${file}.bak`);
        this.notices.push({ type: 'recovered', file: path.basename(file) });
        return v;
      } catch {
        this.notices.push({ type: 'reset', file: path.basename(file) });
        return fallback;
      }
    }
  }
}

function sanitizeSettings(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if ('moviesDir' in patch) out.moviesDir = patch.moviesDir ? String(patch.moviesDir) : null;
  if ('tmdbApiKey' in patch) out.tmdbApiKey = patch.tmdbApiKey ? String(patch.tmdbApiKey).trim() : null;
  if ('minFileSizeMB' in patch) {
    const n = Number(patch.minFileSizeMB);
    out.minFileSizeMB = Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.minFileSizeMB;
  }
  return out;
}

function sanitizeLibrary(lib) {
  const out = EMPTY_LIBRARY();
  out.updatedAt = lib.updatedAt || null;
  for (const [id, m] of Object.entries(lib.movies)) {
    if (!m || typeof m !== 'object' || typeof m.path !== 'string' || !m.path) continue;
    out.movies[id] = { ...m, id: m.id || id, kind: m.kind || 'movie', parsed: m.parsed || { title: '', year: null }, status: m.status || 'pending' };
  }
  if (lib.shows && typeof lib.shows === 'object') {
    for (const [key, sh] of Object.entries(lib.shows)) {
      if (!sh || typeof sh !== 'object') continue;
      out.shows[key] = { ...sh, key, seasons: sh.seasons && typeof sh.seasons === 'object' ? sh.seasons : {} };
    }
  }
  return out;
}

async function isDirectory(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

module.exports = { Store, DEFAULT_SETTINGS, DEFAULT_MOVIES_DIR, EMPTY_LIBRARY };
module.exports.exists = (p) => fs.existsSync(p);
