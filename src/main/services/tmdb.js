'use strict';
// Thin TMDB v3 client: search, details, image download. Uses Node's global fetch.
// Errors carry a `kind`: 'NO_API_KEY' | 'INVALID_API_KEY' | 'NETWORK' | 'NOT_FOUND' | 'HTTP'.

const fsp = require('fs/promises');
const path = require('path');

const API = process.env.TMDB_API_BASE || 'https://api.themoviedb.org/3';
const IMG = process.env.TMDB_IMG_BASE || 'https://image.tmdb.org/t/p';
const TIMEOUT_MS = 15000;
const MAX_FALLBACK_SEARCHES = 4;
// Bump when details() gains fields so existing matches get refreshed (details only, no search).
const METADATA_VERSION = 2;

// In the Electron main process prefer Chromium's network stack (system DNS, proxies,
// certificate store). Plain Node (tests, scripts) falls back to the global fetch.
const doFetch = (() => {
  try {
    const electron = require('electron');
    if (electron && electron.net && typeof electron.net.fetch === 'function') return (u, o) => electron.net.fetch(String(u), o);
  } catch {
    /* not running inside Electron */
  }
  return (u, o) => globalThis.fetch(u, o);
})();

class TmdbError extends Error {
  constructor(kind, message) {
    super(message || kind);
    this.kind = kind;
  }
}

class TmdbClient {
  constructor(getApiKey) {
    this._getApiKey = getApiKey; // function returning the current key (may change at runtime)
  }

  get hasKey() {
    return Boolean(this._getApiKey());
  }

  async _request(endpoint, params = {}) {
    const key = this._getApiKey();
    if (!key) throw new TmdbError('NO_API_KEY');
    const url = new URL(API + endpoint);
    const headers = { Accept: 'application/json' };
    // v4 read-access tokens are long JWTs; v3 keys are 32-char hex.
    if (key.length > 40) headers.Authorization = `Bearer ${key}`;
    else url.searchParams.set('api_key', key);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    let networkFailures = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      let res;
      try {
        res = await doFetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (err) {
        // One transient failure (DNS hiccup, first connection) shouldn't stall the whole batch.
        if (++networkFailures <= 2) {
          await sleep(1000 * networkFailures);
          continue;
        }
        throw new TmdbError('NETWORK', `TMDB unreachable: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`);
      }
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after') || 1.5) * 1000;
        await sleep(Math.min(wait, 10000));
        continue;
      }
      if (res.status === 401) throw new TmdbError('INVALID_API_KEY', 'TMDB rejected the API key');
      if (res.status === 404) throw new TmdbError('NOT_FOUND', `TMDB 404 for ${endpoint}`);
      if (res.status >= 500) throw new TmdbError('NETWORK', `TMDB ${res.status}`);
      if (!res.ok) throw new TmdbError('HTTP', `TMDB ${res.status} for ${endpoint}`);
      try {
        return await res.json();
      } catch (err) {
        throw new TmdbError('NETWORK', `TMDB bad JSON: ${err.message}`);
      }
    }
    throw new TmdbError('NETWORK', 'TMDB rate limited');
  }

  async search(query, year) {
    if (!query) return [];
    const data = await this._request('/search/movie', {
      query,
      year: year || undefined,
      include_adult: 'false',
      language: 'en-US',
    });
    return (data.results || []).map(summarize);
  }

  /** Try progressively looser searches (bounded) until something comes back. */
  async findBest(title, year) {
    if (!title) return null;
    let searches = 0;
    const run = async (q, y) => {
      searches++;
      return this.search(q, y);
    };
    let results = await run(title, year);
    if (!results.length && year) results = await run(title);
    if (!results.length) {
      // Drop trailing words one at a time (handles leftover tags / subtitles).
      const words = title.split(' ');
      for (let n = words.length - 1; n >= 2 && !results.length && searches < MAX_FALLBACK_SEARCHES; n--) {
        results = await run(words.slice(0, n).join(' '), year);
      }
    }
    if (!results.length) return null;
    return pickBest(results, title, year);
  }

  // ---------------------------------------------------------------- TV

  async searchTv(query, year) {
    if (!query) return [];
    const data = await this._request('/search/tv', {
      query,
      first_air_date_year: year || undefined,
      include_adult: 'false',
      language: 'en-US',
    });
    return (data.results || []).map(summarizeTv);
  }

  async findBestTv(title, year) {
    if (!title) return null;
    let searches = 0;
    const run = async (q, y) => {
      searches++;
      return this.searchTv(q, y);
    };
    let results = await run(title, year);
    if (!results.length && year) results = await run(title);
    if (!results.length) {
      const words = title.split(' ');
      for (let n = words.length - 1; n >= 1 && !results.length && searches < MAX_FALLBACK_SEARCHES; n--) {
        results = await run(words.slice(0, n).join(' '));
      }
    }
    if (!results.length) return null;
    return pickBest(results, title, year);
  }

  async tvDetails(id) {
    const d = await this._request(`/tv/${id}`, { language: 'en-US' });
    return {
      id: d.id,
      title: d.name,
      originalTitle: d.original_name,
      year: d.first_air_date ? Number(d.first_air_date.slice(0, 4)) : null,
      endYear: d.last_air_date ? Number(d.last_air_date.slice(0, 4)) : null,
      overview: d.overview || '',
      rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
      runtime: Array.isArray(d.episode_run_time) && d.episode_run_time.length ? d.episode_run_time[0] : null,
      genres: (d.genres || []).map((g) => g.name),
      tagline: d.tagline || '',
      posterPath: d.poster_path || null,
      backdropPath: d.backdrop_path || null,
      originalLanguage: d.original_language || null,
      spokenLanguages: (d.spoken_languages || []).map((l) => l.iso_639_1).filter(Boolean),
      numberOfSeasons: d.number_of_seasons || null,
      numberOfEpisodes: d.number_of_episodes || null,
      showStatus: d.status || null,
      metadataVersion: METADATA_VERSION,
    };
  }

  /** Episode names/overviews/stills for one season. */
  async seasonDetails(tvId, seasonNumber) {
    const d = await this._request(`/tv/${tvId}/season/${seasonNumber}`, { language: 'en-US' });
    const episodes = {};
    for (const e of d.episodes || []) {
      episodes[e.episode_number] = {
        name: e.name || '',
        overview: e.overview || '',
        stillPath: e.still_path || null,
        airDate: e.air_date || null,
        runtime: e.runtime || null,
        rating: e.vote_average ? Math.round(e.vote_average * 10) / 10 : null,
      };
    }
    return {
      number: d.season_number ?? seasonNumber,
      name: d.name || `Season ${seasonNumber}`,
      overview: d.overview || '',
      posterPath: d.poster_path || null,
      airDate: d.air_date || null,
      episodes,
      fetchedAt: new Date().toISOString(),
    };
  }

  async details(id) {
    const d = await this._request(`/movie/${id}`, { language: 'en-US' });
    return {
      id: d.id,
      title: d.title,
      originalTitle: d.original_title,
      year: d.release_date ? Number(d.release_date.slice(0, 4)) : null,
      overview: d.overview || '',
      rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
      runtime: d.runtime || null,
      genres: (d.genres || []).map((g) => g.name),
      tagline: d.tagline || '',
      posterPath: d.poster_path || null,
      backdropPath: d.backdrop_path || null,
      originalLanguage: d.original_language || null,
      spokenLanguages: (d.spoken_languages || []).map((l) => l.iso_639_1).filter(Boolean),
      metadataVersion: METADATA_VERSION,
    };
  }

  /** Download an image if not already cached. Returns the local file path, or null on any failure. */
  async downloadImage(tmdbPath, size, destDir, fileStem) {
    if (!tmdbPath) return null;
    const dest = path.join(destDir, `${fileStem}${path.extname(tmdbPath) || '.jpg'}`);
    try {
      const st = await fsp.stat(dest);
      if (st.size > 0) return dest;
    } catch {
      /* not cached yet */
    }
    try {
      const res = await doFetch(`${IMG}/${size}${tmdbPath}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) return null;
      const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      await fsp.writeFile(tmp, buf);
      try {
        await fsp.rename(tmp, dest);
      } catch (err) {
        await fsp.unlink(tmp).catch(() => {});
        // Another download of the same image may have landed first; that's fine.
        const st = await fsp.stat(dest).catch(() => null);
        if (!st || st.size === 0) throw err;
      }
      return dest;
    } catch (err) {
      console.warn('[tmdb] image download failed', tmdbPath, err.message);
      return null;
    }
  }
}

function summarize(r) {
  return {
    id: r.id,
    title: r.title,
    originalTitle: r.original_title,
    year: r.release_date ? Number(r.release_date.slice(0, 4)) : null,
    overview: r.overview || '',
    rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
    popularity: r.popularity || 0,
    posterPath: r.poster_path || null,
    backdropPath: r.backdrop_path || null,
  };
}

function summarizeTv(r) {
  return {
    id: r.id,
    title: r.name,
    originalTitle: r.original_name,
    year: r.first_air_date ? Number(r.first_air_date.slice(0, 4)) : null,
    overview: r.overview || '',
    rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
    popularity: r.popularity || 0,
    posterPath: r.poster_path || null,
    backdropPath: r.backdrop_path || null,
  };
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function pickBest(results, title, year) {
  const nt = norm(title);
  let best = null;
  let bestScore = -Infinity;
  for (const r of results) {
    let score = 0;
    const rt = norm(r.title);
    const ro = norm(r.originalTitle);
    if (rt === nt || ro === nt) score += 50;
    else if (rt.startsWith(nt) || nt.startsWith(rt)) score += 20;
    if (year && r.year) {
      const diff = Math.abs(r.year - year);
      score += diff === 0 ? 30 : diff === 1 ? 15 : -10;
    }
    score += Math.min(r.popularity, 100) / 10;
    if (r.posterPath) score += 5;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { TmdbClient, TmdbError, IMG, METADATA_VERSION };
