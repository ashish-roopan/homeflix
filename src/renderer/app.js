'use strict';
// App controller: state, routing between Settings / Home / Player / List, and Home rendering.
(function () {
  const { h } = UI;
  const viewEl = document.getElementById('view');
  document.body.dataset.platform = UI.platform; // styles.css adjusts the top bar per platform
  const STALE_PROGRESS_MS = 5 * 60 * 1000;
  const STRUCTURAL_DEBOUNCE_MS = 4000;
  const HERO_ROTATE_MS = 8000; // the big banner moves on to the next title this often

  const state = {
    settings: null,
    movies: [],
    shows: [],
    byId: new Map(), // movie id -> movie, 'show:key' -> show
    meta: { folderMissing: false, moviesDir: null, failedDirs: [] },
    view: 'home', // 'home' | 'settings' | 'player' | 'list'
    query: '',
    progress: { phase: 'idle', done: 0, total: 0, current: '' },
    progressAt: 0,
    playing: null, // movie or episode
    playingShow: null,
    firstRun: false,
    heroIndex: {}, // page -> position in the rotating hero pool
    heroTimer: null,
    listView: null, // { title, ids }
    banners: { tmdbDown: false, keyDismissed: false, invalidKey: false },
    structuralTimer: null,
    page: 'home', // 'home' (mixed) | 'shows' | 'movies', like Netflix's left rail
    browse: 'all', // 'all' | 'genre' | 'language' | 'rating' | 'decade': how the page is grouped
    searchOpen: false, // the search field is shown (Search in the left rail)
    focusSearch: false, // focus the search field on the next render (set when Search is chosen)
  };
  const PAGES = [['home', 'Home'], ['shows', 'Series'], ['movies', 'Movies']];
  const BROWSE_MODES = [['all', 'All'], ['genre', 'Genre'], ['language', 'Language'], ['rating', 'Rating'], ['decade', 'Decade']];
  try {
    const page = localStorage.getItem('page');
    if (PAGES.some(([k]) => k === page)) state.page = page;
    const browse = localStorage.getItem('browse');
    if (BROWSE_MODES.some(([k]) => k === browse)) state.browse = browse;
  } catch { /* storage unavailable */ }
  const MIN_ROW = 2; // rows need at least this many titles to be worth showing
  window.__firstRenderAt = null;

  // ---------- data ----------
  function applyLibrary(lib) {
    state.movies = lib.movies;
    state.shows = lib.shows || [];
    state.byId = new Map([...lib.movies.map((m) => [m.id, m]), ...state.shows.map((s) => [s.id, s])]);
    state.meta = { folderMissing: lib.folderMissing, moviesDir: lib.moviesDir, failedDirs: lib.failedDirs || [] };
  }

  /** Netflix-style pages: Home shows everything, Series and Movies only their kind. */
  function pageItems(items) {
    if (state.page === 'movies') return items.filter((m) => m.kind !== 'show');
    if (state.page === 'shows') return items.filter((m) => m.kind === 'show');
    return items;
  }
  function setPage(page) {
    state.page = page;
    state.browse = 'all';
    state.query = '';
    state.searchOpen = false;
    state.listView = null;
    state.view = 'home';
    try { localStorage.setItem('page', page); localStorage.setItem('browse', 'all'); } catch { /* ignore */ }
    render();
  }
  function toggleSearch() {
    if (state.view !== 'home') {
      state.view = 'home';
      state.listView = null;
      state.searchOpen = false;
    }
    state.searchOpen = !state.searchOpen;
    if (!state.searchOpen) state.query = '';
    state.focusSearch = state.searchOpen;
    render();
  }

  async function load() {
    state.settings = await window.api.getSettings();
    applyLibrary(await window.api.getLibrary());
    if (!state.settings.moviesDir) {
      state.firstRun = true;
      state.view = 'settings';
    }
    render();
    window.api.getNotices().then((notices) => {
      for (const n of notices || []) {
        if (n.type === 'recovered') UI.toast(`${n.file} was damaged and restored from its backup.`, { ms: 6000 });
        if (n.type === 'reset') UI.toast(`${n.file} was damaged and could not be recovered. Rescanning.`, { kind: 'error', ms: 8000 });
      }
    }).catch(() => {});
  }

  window.api.onLibraryChanged((lib) => {
    applyLibrary(lib);
    if (state.view === 'home') renderHome();
    else if (state.view === 'list') renderList();
  });

  window.api.onMoviesUpdated(({ movies, shows }) => {
    let structural = false;
    const merge = (list, m) => {
      const prev = state.byId.get(m.id);
      if (!prev) {
        structural = true;
        list.push(m);
        state.byId.set(m.id, m);
      } else {
        if (prev.status !== m.status || Boolean(prev.downloading) !== Boolean(m.downloading) || Boolean(prev.missing) !== Boolean(m.missing)) structural = true;
        if (m.kind === 'show' && (prev.episodeCount !== m.episodeCount || prev.seasonCount !== m.seasonCount)) structural = true;
        Object.assign(prev, m);
      }
      if (state.view === 'home' || state.view === 'list') patchCards(state.byId.get(m.id));
    };
    for (const m of movies || []) merge(state.movies, m);
    for (const s of shows || []) merge(state.shows, s);
    if (structural) scheduleStructural();
  });

  window.api.onProgress((p) => {
    state.progress = p;
    state.progressAt = Date.now();
    if (p.error === 'FOLDER_MISSING') state.meta.folderMissing = true;
    if (p.error === 'TMDB_UNREACHABLE') state.banners.tmdbDown = true;
    else if (p.phase === 'idle' && !p.error) state.banners.tmdbDown = false;
    if (p.error === 'INVALID_API_KEY') state.banners.invalidKey = true;
    else if (p.phase === 'idle' && !p.error) state.banners.invalidKey = false;
    if (p.error === 'SCAN_FAILED') UI.toast(`Scan failed: ${p.message || 'unknown error'}`, { kind: 'error', ms: 6000 });
    if (state.view === 'home') {
      renderProgress();
      renderBanners();
    }
  });

  /** Replace every card for an item in place (no full re-render). */
  function patchCards(item) {
    if (!item) return;
    const cards = viewEl.querySelectorAll(`.card[data-id="${CSS.escape(item.id)}"]`);
    if (!cards.length) return;
    const shown = decorate(item);
    for (const card of cards) {
      const fresh = UI.renderCard(shown, handlers);
      if (card === document.activeElement) fresh.focus();
      card.replaceWith(fresh);
    }
  }

  function userBusy() {
    const overlay = document.getElementById('overlay');
    if (!overlay.hidden) return true;
    const a = document.activeElement;
    if (a && /INPUT|TEXTAREA/.test(a.tagName)) return true;
    if (viewEl.querySelector('.card:hover')) return true;
    return false;
  }

  /** Rows need rebuilding (an item changed status/genre). Do it when the user is idle. */
  function scheduleStructural() {
    clearTimeout(state.structuralTimer);
    state.structuralTimer = setTimeout(() => {
      if (state.view !== 'home') return;
      if (userBusy()) return scheduleStructural();
      renderHome();
    }, STRUCTURAL_DEBOUNCE_MS);
  }

  // ---------- actions ----------
  const handlers = {
    onOpen: (item) => {
      if (item.kind === 'show') UI.openShowDetail(item, { onPlayEpisode: playEpisode, onChanged: () => {}, onRescan: () => rescan(false) });
      else UI.openDetail(item, { onPlay: play, onChanged: () => {}, onRescan: () => rescan(false) });
    },
    onPlay: (item) => {
      if (item.kind === 'show') {
        const next = item.playback && item.playback.next;
        if (!next) return UI.toast('You have watched every episode you have of this show.');
        return playEpisode(next, item);
      }
      return play(item);
    },
  };

  async function fileOk(item) {
    if (item.missing) {
      UI.toast('That file can’t be found. Was it moved or deleted?', { kind: 'error' });
      return false;
    }
    try {
      const check = await window.api.checkFile(item.id);
      if (!check.ok) {
        item.missing = true;
        patchCards(item);
        UI.toast(check.code === 'ENOENT' ? 'That file can’t be found. Was it moved or deleted?' : `Can’t open file (${check.code}).`, { kind: 'error' });
        return false;
      }
    } catch (err) {
      UI.toast(err.message, { kind: 'error' });
      return false;
    }
    return true;
  }

  async function play(movie) {
    if (!(await fileOk(movie))) return;
    state.playing = movie;
    state.playingShow = null;
    state.view = 'player';
    render();
  }

  async function playEpisode(episode, show) {
    if (!(await fileOk(episode))) return;
    state.playing = episode;
    state.playingShow = show || state.shows.find((s) => s.key === episode.showKey) || null;
    state.view = 'player';
    render();
  }

  /** Episodes of a show in watch order. */
  function episodesOf(show) {
    return show ? show.seasons.flatMap((s) => s.episodes) : [];
  }
  function nextEpisodeAfter(show, episode) {
    const eps = episodesOf(show);
    const i = eps.findIndex((e) => e.id === episode.id);
    for (let k = i + 1; k < eps.length; k++) if (!eps[k].missing) return eps[k];
    return null;
  }

  async function rescan(force) {
    const stale = Date.now() - state.progressAt > STALE_PROGRESS_MS;
    if (state.progress.phase !== 'idle' && !stale) return;
    try {
      await window.api.scanLibrary({ force });
    } catch (err) {
      UI.toast(err.message, { kind: 'error' });
    }
  }

  function openSettings() {
    state.view = 'settings';
    render();
  }

  // ---------- derived data ----------
  /** Dedupe matched movies by TMDB id (keep the best file) and annotate duplicates. */
  function visibleMovies() {
    const groups = new Map();
    const out = [];
    for (const m of state.movies) {
      const key = m.status === 'matched' && m.tmdb ? `t${m.tmdb.id}` : `f${m.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => Number(a.partial) - Number(b.partial) || Number(a.missing) - Number(b.missing) || b.size - a.size);
      const best = decorate(list[0]);
      best.dupCount = list.length;
      best.dupes = list.slice(1);
      out.push(best);
    }
    return out;
  }

  /** Everything that gets a card: movies (deduped) + shows. */
  function allItems() {
    return [...visibleMovies(), ...state.shows.map(decorate)];
  }

  function decorate(m) {
    return { ...m, dupCount: m.dupCount || 1, dupes: m.dupes || [] };
  }

  /** Titles worth a banner: the most recent additions plus a few top-rated ones, backdrops only. */
  function heroPool(items) {
    const good = items.filter((m) => m.status === 'matched' && m.backdropUrl && !m.missing && !m.downloading);
    const pool = good.length ? good : items.filter((m) => !m.missing);
    if (!pool.length) return items.slice(0, 1);
    const recent = [...pool].sort(byAddedDesc).slice(0, 10);
    const top = [...pool].sort(byRatingDesc).filter((m) => !recent.includes(m)).slice(0, 6);
    return [...recent, ...top];
  }
  function pickFeatured(items) {
    const pool = heroPool(items);
    if (!pool.length) return null;
    const i = (state.heroIndex[state.page] || 0) % pool.length;
    state.heroIndex[state.page] = i;
    return pool[i];
  }
  /** Swap the banner in place every HERO_ROTATE_MS, unless the user is looking at or using it. */
  function startHeroRotation() {
    clearInterval(state.heroTimer);
    state.heroTimer = setInterval(() => {
      if (state.view !== 'home' || state.query || !document.getElementById('overlay').hidden || document.hidden) return;
      const heroEl = viewEl.querySelector('.hero');
      if (!heroEl || heroEl.matches(':hover') || heroEl.contains(document.activeElement)) return;
      const pool = heroPool(pageItems(allItems()));
      if (pool.length < 2) return;
      state.heroIndex[state.page] = ((state.heroIndex[state.page] || 0) + 1) % pool.length;
      const fresh = UI.renderHero(pool[state.heroIndex[state.page]], { onPlay: handlers.onPlay, onInfo: handlers.onOpen });
      fresh.classList.add('hero-enter');
      heroEl.replaceWith(fresh);
    }, HERO_ROTATE_MS);
  }

  // ---------- grouping ----------
  const langNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'language' }); } catch { return null; } })();
  function languageName(code) {
    if (!code) return null;
    try {
      const n = langNames && langNames.of(code);
      return n && n !== code ? n : code.toUpperCase();
    } catch {
      return code.toUpperCase();
    }
  }
  /** Languages an item is available in: TMDB original language + languages tagged in file names. */
  function itemLanguages(m) {
    const codes = new Set();
    if (m.tmdb && m.tmdb.originalLanguage) codes.add(m.tmdb.originalLanguage);
    for (const c of (m.parsed && m.parsed.languages) || []) codes.add(c);
    for (const d of m.dupes || []) for (const c of (d.parsed && d.parsed.languages) || []) codes.add(c);
    return [...codes];
  }
  function groupBy(items, keysOf, { min = MIN_ROW, sortRows } = {}) {
    const map = new Map();
    for (const m of items) for (const k of keysOf(m) || []) {
      if (!k) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(m);
    }
    let rows = [...map.entries()].filter(([, list]) => list.length >= min);
    rows = sortRows ? rows.sort(sortRows) : rows.sort((a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0])));
    return rows;
  }
  const RATING_BUCKETS = [
    ['Top rated ★ 8+', (r) => r >= 8],
    ['Great ★ 7 – 8', (r) => r >= 7 && r < 8],
    ['Good ★ 6 – 7', (r) => r >= 6 && r < 7],
    ['Mixed ★ 5 – 6', (r) => r >= 5 && r < 6],
    ['Low ★ under 5', (r) => r > 0 && r < 5],
  ];
  function ratingBucket(m) {
    const r = m.tmdb && m.tmdb.rating;
    if (!r) return ['Not rated yet'];
    const b = RATING_BUCKETS.find(([, test]) => test(r));
    return b ? [b[0]] : [];
  }
  function decadeOf(m) {
    const y = UI.displayYear(m);
    if (!y) return ['Unknown year'];
    const d = Math.floor(y / 10) * 10;
    return [d >= 2000 ? `${d}s` : `${String(d).slice(2)}s`];
  }
  const rating = (m) => (m.tmdb && m.tmdb.rating) || 0;
  const byRatingDesc = (a, b) => rating(b) - rating(a);
  const byYearDesc = (a, b) => (UI.displayYear(b) || 0) - (UI.displayYear(a) || 0);
  const byAddedDesc = (a, b) => (b.addedAt || '').localeCompare(a.addedAt || '');
  const genresOf = (m) => (m.tmdb && m.tmdb.genres) || [];

  // ---------- recommendations (local, from watch history) ----------
  function lastPlayedAt(m) {
    return (m.playback && m.playback.lastPlayedAt) || null;
  }
  function watchWeight(m) {
    const f = UI.watchedFraction(m);
    const started = m.kind === 'show' ? Boolean(m.playback && m.playback.started) : f > 0;
    if (!started) return 0;
    const when = lastPlayedAt(m);
    const days = when ? Math.max(0, (Date.now() - Date.parse(when)) / 86400000) : 60;
    const recency = Math.max(0.15, Math.pow(0.5, days / 45));
    const completion = m.kind === 'show' ? 0.8 : 0.3 + 0.7 * f;
    return completion * recency;
  }
  function buildProfile(items) {
    const genres = new Map();
    const langs = new Map();
    const decades = new Map();
    const bump = (map, k, w) => k && map.set(k, (map.get(k) || 0) + w);
    let total = 0;
    for (const m of items) {
      const w = watchWeight(m);
      if (!w) continue;
      total += w;
      for (const g of genresOf(m)) bump(genres, g, w);
      for (const l of itemLanguages(m)) bump(langs, l, w);
      for (const d of decadeOf(m)) if (d !== 'Unknown year') bump(decades, d, w);
    }
    const norm = (map) => {
      const max = Math.max(0, ...map.values());
      const out = new Map();
      for (const [k, v] of map) out.set(k, max ? v / max : 0);
      return out;
    };
    return { total, genres: norm(genres), langs: norm(langs), decades: norm(decades) };
  }
  const isCandidate = (m) => m.status === 'matched' && !m.missing && !m.downloading && watchWeight(m) === 0 && !(m.kind === 'show' && m.playback && m.playback.finished);
  function recommendScore(profile, m) {
    const gs = genresOf(m);
    const genre = gs.length ? gs.reduce((a, g) => a + (profile.genres.get(g) || 0), 0) / gs.length : 0;
    const lang = Math.max(0, ...itemLanguages(m).map((l) => profile.langs.get(l) || 0));
    const dec = Math.max(0, ...decadeOf(m).map((d) => profile.decades.get(d) || 0));
    const q = Math.max(0, (rating(m) - 6) / 4);
    return genre * 2 + lang * 1 + dec * 0.4 + q * 0.6;
  }
  function similarity(a, b) {
    const ga = new Set(genresOf(a));
    const gb = new Set(genresOf(b));
    const shared = [...ga].filter((g) => gb.has(g)).length;
    const union = new Set([...ga, ...gb]).size || 1;
    const lang = itemLanguages(a).some((l) => itemLanguages(b).includes(l)) ? 1 : 0;
    const ya = UI.displayYear(a);
    const yb = UI.displayYear(b);
    const year = ya && yb ? Math.max(0, 1 - Math.abs(ya - yb) / 30) : 0;
    const kind = a.kind === b.kind ? 0.3 : 0;
    return (shared / union) * 2 + lang + year * 0.5 + kind;
  }
  /** Rows derived from what the user has watched. */
  function recommendationRows(items, handlers, rowOpts) {
    const rows = [];
    const profile = buildProfile(items);
    if (!profile.total) return rows;
    const candidates = items.filter(isCandidate);
    if (!candidates.length) return rows;

    const scored = candidates.map((m) => [m, recommendScore(profile, m)]).filter(([, s]) => s >= 0.5).sort((a, b) => b[1] - a[1]);
    if (scored.length >= MIN_ROW) rows.push(UI.renderRow('Recommended for you', scored.slice(0, 30).map(([m]) => m), handlers, { ...rowOpts, hint: 'based on what you watched' }));

    const recentWatched = items.filter((m) => watchWeight(m) > 0 && genresOf(m).length).sort((a, b) => (lastPlayedAt(b) || '').localeCompare(lastPlayedAt(a) || '')).slice(0, 2);
    const used = new Set(scored.slice(0, 10).map(([m]) => m.id));
    for (const w of recentWatched) {
      const similar = candidates.filter((m) => m.id !== w.id).map((m) => [m, similarity(w, m)]).filter(([, s]) => s >= 1.2).sort((a, b) => b[1] - a[1]).map(([m]) => m);
      const fresh = similar.filter((m) => !used.has(m.id));
      const list = fresh.length >= MIN_ROW ? fresh : similar;
      if (list.length >= MIN_ROW) {
        rows.push(UI.renderRow(`Because you watched ${UI.displayTitle(w)}`, list.slice(0, 20), handlers, rowOpts));
        for (const m of list.slice(0, 10)) used.add(m.id);
      }
    }
    return rows;
  }

  function renderBrowseBar() {
    return h('nav.browse',
      h('span.browse-label', 'Browse by'),
      BROWSE_MODES.map(([key, label]) =>
        h('button.chip', { class: `chip${state.browse === key ? ' is-active' : ''}`, onClick: () => { state.browse = key; try { localStorage.setItem('browse', key); } catch { /* ignore */ } renderHome(); } }, label)
      )
    );
  }

  /** Rows for the current page (Home / Series / Movies) in the current browse mode. */
  function pageRows(items, handlers, rowOpts) {
    const rows = [];
    const matched = items.filter((m) => m.status === 'matched');
    const mixed = state.page === 'home';
    const noun = state.page === 'shows' ? 'series' : state.page === 'movies' ? 'movies' : 'titles';
    const alpha = (list) => [...list].sort((a, b) => UI.displayTitle(a).localeCompare(UI.displayTitle(b)));
    switch (state.browse) {
      case 'genre':
        for (const [g, list] of groupBy(matched, genresOf)) rows.push(UI.renderRow(g, [...list].sort(byRatingDesc), handlers, rowOpts));
        break;
      case 'language':
        for (const [code, list] of groupBy(items, itemLanguages, { min: 1 })) rows.push(UI.renderRow(languageName(code), [...list].sort(byYearDesc), handlers, rowOpts));
        {
          const unknown = items.filter((m) => !itemLanguages(m).length);
          if (unknown.length) rows.push(UI.renderRow('Language unknown', unknown, handlers, rowOpts));
        }
        break;
      case 'rating': {
        const order = [...RATING_BUCKETS.map((b) => b[0]), 'Not rated yet'];
        for (const [label, list] of groupBy(items, ratingBucket, { min: 1, sortRows: (a, b) => order.indexOf(a[0]) - order.indexOf(b[0]) })) {
          rows.push(UI.renderRow(label, [...list].sort(byRatingDesc), handlers, rowOpts));
        }
        break;
      }
      case 'decade': {
        const val = (k) => (k === 'Unknown year' ? -1 : k.length === 3 ? 1900 + Number(k.slice(0, 2)) : Number(k.slice(0, 4)));
        for (const [label, list] of groupBy(items, decadeOf, { min: 1, sortRows: (a, b) => val(b[0]) - val(a[0]) })) {
          rows.push(UI.renderRow(label, [...list].sort(byYearDesc), handlers, rowOpts));
        }
        break;
      }
      default: {
        // The page's own mix: what you're watching, what we'd suggest, then browsing rows,
        // with the housekeeping rows (recently added, everything, downloads, problems) at the bottom.
        const continueWatching = items
          .filter((m) => !m.missing && (m.kind === 'show'
            ? m.playback && m.playback.started && !m.playback.finished
            : m.playback && !m.playback.finished && m.playback.position > 0))
          .sort((a, b) => (lastPlayedAt(b) || '').localeCompare(lastPlayedAt(a) || ''));
        rows.push(UI.renderRow('Continue watching', continueWatching, handlers, { ...rowOpts, min: 1 }));
        rows.push(...recommendationRows(items, handlers, rowOpts));
        if (mixed) {
          const shows = items.filter((m) => m.kind === 'show');
          if (shows.length && shows.length < items.length) rows.push(UI.renderRow('Series', [...shows].sort(byAddedDesc), handlers, rowOpts));
        }
        const topRated = matched.filter((m) => rating(m)).sort(byRatingDesc).slice(0, 40);
        if (topRated.length >= 3 && matched.length > 6) rows.push(UI.renderRow('Top rated', topRated, handlers, rowOpts));
        const langs = groupBy(items, itemLanguages);
        if (langs.length >= 2) for (const [code, list] of langs.slice(0, 4)) rows.push(UI.renderRow(`${languageName(code)} ${noun}`, [...list].sort(byYearDesc), handlers, rowOpts));
        for (const [g, list] of groupBy(matched, genresOf, { min: 3 })) rows.push(UI.renderRow(g, mixed ? list : [...list].sort(byRatingDesc), handlers, rowOpts));

        const byAdded = items.filter((m) => !m.downloading && !m.missing).sort(byAddedDesc);
        rows.push(UI.renderRow('Recently added', byAdded.slice(0, 40), handlers, rowOpts));
        if (!mixed || items.length > 30) rows.push(UI.renderRow(`All ${noun}`, alpha(items), handlers, rowOpts));
        rows.push(UI.renderRow('Downloading', items.filter((m) => m.downloading), handlers, rowOpts));
        // Without a key nothing could be looked up, so "Needs a match" would just mirror the library.
        if (UI.hasTmdbKey) rows.push(UI.renderRow('Needs a match', items.filter((m) => m.status === 'unmatched' && !m.downloading && !m.missing), handlers, rowOpts));
        rows.push(UI.renderRow('Missing files', items.filter((m) => m.missing), handlers, rowOpts));
      }
    }
    return rows;
  }

  // ---------- rendering ----------
  function render() {
    document.body.dataset.view = state.view;
    clearInterval(state.heroTimer);
    if (state.view === 'settings') {
      UI.renderSettings(viewEl, state.settings, {
        firstRun: state.firstRun,
        onCancel: state.firstRun ? null : () => { state.view = 'home'; render(); },
        onSaved: async (saved) => {
          const keyChanged = saved.tmdbApiKey !== state.settings.tmdbApiKey;
          state.settings = saved;
          state.firstRun = false;
          state.view = 'home';
          state.banners.keyDismissed = false;
          state.banners.invalidKey = false;
          state.meta.folderMissing = false;
          render();
          rescan(keyChanged);
        },
      });
      if (!state.firstRun) viewEl.appendChild(renderSidebar());
      return;
    }
    if (state.view === 'player') {
      const show = state.playingShow;
      const next = show && state.playing.kind === 'episode' ? nextEpisodeAfter(show, state.playing) : null;
      UI.renderPlayer(viewEl, state.playing, {
        nextEpisode: next,
        onNext: async (ep) => {
          // Refresh so the show's episode list and progress are current, then continue.
          try { applyLibrary(await window.api.getLibrary()); } catch { /* keep what we have */ }
          const freshShow = state.shows.find((s) => s.key === ep.showKey) || show;
          const freshEp = episodesOf(freshShow).find((e) => e.id === ep.id) || ep;
          playEpisode(freshEp, freshShow);
        },
        onBack: async () => {
          try { applyLibrary(await window.api.getLibrary()); } catch { /* keep what we have */ }
          state.playing = null;
          state.playingShow = null;
          state.view = 'home';
          render();
        },
      });
      return;
    }
    if (state.view === 'list') return renderList();
    renderHome();
  }

  /** Netflix-style left rail: Search, Home, Series, Movies; Rescan and Settings at the bottom. */
  function renderSidebar() {
    const onHome = state.view === 'home' && !state.searchOpen;
    const item = (icon, label, { active, onClick, onContextmenu, title } = {}) =>
      h('button', { class: `sidebar-item${active ? ' is-active' : ''}`, title: title || label, 'aria-label': label, onClick, onContextmenu },
        UI.icon(icon), h('span.sidebar-label', label));
    return h('aside.sidebar',
      h('button.sidebar-brand', { 'aria-label': 'Homeflix', onClick: () => setPage('home') }, h('span.sidebar-brand-mark', 'H'), h('span.sidebar-label', 'HOMEFLIX')),
      item('search', 'Search', { active: state.view === 'home' && state.searchOpen, onClick: toggleSearch }),
      PAGES.map(([key, label]) => item(key === 'home' ? 'home' : key === 'shows' ? 'tv' : 'film', label, { active: onHome && state.page === key, onClick: () => setPage(key) })),
      h('div.sidebar-spacer'),
      item('refresh', 'Rescan', { title: 'Rescan folder (right-click: retry unmatched)', onClick: () => rescan(false), onContextmenu: (e) => { e.preventDefault(); rescan(true); } }),
      item('gear', 'Settings', { active: state.view === 'settings', onClick: openSettings })
    );
  }

  /** Slim top strip over the content: scan progress and, when Search is open, the search field. */
  function renderTopbar() {
    const searchInput = h('input.search-input', {
      type: 'search',
      placeholder: 'Search titles, genres, languages…',
      value: state.query,
      onInput: UI.debounce((e) => { state.query = e.target.value; renderHome(); }, 150),
    });
    const bar = h('header.topbar',
      state.searchOpen || state.query ? h('label.search', UI.icon('search'), searchInput) : null,
      h('div.topbar-spacer'),
      h('div#progress.progress', { hidden: true })
    );
    return { bar, searchInput };
  }

  function renderProgress() {
    const el = document.getElementById('progress');
    if (!el) return;
    UI.clear(el);
    const p = state.progress;
    if (p.phase === 'idle') {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const label = p.phase === 'scanning'
      ? 'Scanning folder…'
      : `Identifying ${p.done}/${p.total}${p.current ? ` · ${p.current}` : ''}`;
    UI.append(el, [h('span.spinner'), h('span', label)]);
  }

  function renderBanners() {
    const el = document.getElementById('banners');
    if (!el) return;
    UI.clear(el);
    const banners = [];
    if (state.meta.folderMissing) {
      banners.push(h('div.banner.banner-warn',
        UI.icon('warn'),
        h('div.banner-text', h('strong', 'Can’t find your movies folder. '), h('span.mono', state.meta.moviesDir || ''), h('span', ' Is the drive connected? Your library is kept until it comes back.')),
        h('button.btn.btn-ghost.btn-small', { onClick: () => rescan(false) }, 'Retry'),
        h('button.btn.btn-ghost.btn-small', { onClick: openSettings }, 'Choose folder')
      ));
    }
    if (state.meta.failedDirs && state.meta.failedDirs.length) {
      banners.push(h('div.banner',
        UI.icon('warn'),
        h('div.banner-text', `${state.meta.failedDirs.length} sub-folder${state.meta.failedDirs.length > 1 ? 's' : ''} couldn’t be read (permissions). Their titles are kept but marked missing.`)
      ));
    }
    if (state.banners.tmdbDown) {
      banners.push(h('div.banner',
        UI.icon('warn'),
        h('div.banner-text', 'TMDB is unreachable. Posters and details will be fetched automatically when the connection is back.'),
        h('button.btn.btn-ghost.btn-small', { onClick: () => rescan(false) }, 'Retry now')
      ));
    }
    if (state.banners.invalidKey) {
      banners.push(h('div.banner.banner-warn',
        UI.icon('warn'),
        h('div.banner-text', 'TMDB rejected your API key.'),
        h('button.btn.btn-ghost.btn-small', { onClick: openSettings }, 'Fix in Settings')
      ));
    } else if (!state.settings.tmdbApiKey && !state.banners.keyDismissed && (state.movies.length || state.shows.length)) {
      banners.push(h('div.banner',
        UI.icon('info'),
        h('div.banner-text', 'Add a free TMDB API key to get posters, ratings and descriptions.'),
        h('button.btn.btn-secondary.btn-small', { onClick: openSettings }, 'Add key'),
        h('button.iconbtn.iconbtn-small', { title: 'Dismiss', onClick: () => { state.banners.keyDismissed = true; renderBanners(); } }, UI.icon('close'))
      ));
    }
    UI.append(el, banners);
    el.hidden = !banners.length;
  }

  function renderHome() {
    try {
      renderHomeUnsafe();
    } catch (err) {
      // Never leave a blank window: show the problem and a way out.
      console.error('renderHome failed', err);
      UI.clear(viewEl);
      viewEl.appendChild(h('div.home', renderTopbar().bar,
        h('div.empty.empty-large', UI.icon('warn'), h('h2', 'Something went wrong drawing the library'), h('p.mono', err && err.message),
          h('div', { style: { display: 'flex', gap: '10px' } },
            h('button.btn.btn-secondary', { onClick: () => { state.browse = 'all'; state.query = ''; renderHome(); } }, 'Reset view'),
            h('button.btn.btn-glass', { onClick: () => location.reload() }, 'Reload')))));
    }
  }

  function renderHomeUnsafe() {
    UI.hasTmdbKey = Boolean(state.settings && state.settings.tmdbApiKey);
    const prev = viewEl.firstElementChild;
    const scrollY = prev && prev.classList.contains('home') ? prev.scrollTop : 0;
    const { bar: topbar, searchInput } = renderTopbar();
    const banners = h('div#banners.banners', { hidden: true });
    const items = allItems();
    const q = state.query.trim().toLowerCase();

    let body;
    if (q) {
      const hits = items.filter((m) => {
        const eps = m.kind === 'show' ? episodesOf(m).map((e) => e.name || '').join(' ') : '';
        const hay = `${UI.displayTitle(m)} ${m.parsed.title} ${m.fileName} ${genresOf(m).join(' ')} ${itemLanguages(m).map(languageName).join(' ')} ${UI.displayYear(m) || ''} ${m.kind === 'show' ? 'series tv show' : 'movie'} ${eps}`.toLowerCase();
        return hay.includes(q);
      });
      body = h('div.home-body.home-search',
        h('h2.row-title', `Results for “${state.query}”`, h('span.row-count', String(hits.length))),
        hits.length ? UI.renderGrid(hits, handlers) : h('div.empty', h('p', 'Nothing matches that search.'))
      );
    } else if (!items.length) {
      body = h('div.home-body',
        h('div.empty.empty-large',
          UI.icon('film'),
          h('h2', state.meta.folderMissing ? 'Movies folder not found' : state.progress.phase === 'idle' ? 'No movies found yet' : 'Scanning…'),
          h('p.muted', state.meta.folderMissing
            ? 'Connect the drive or choose another folder in Settings.'
            : `Drop video files into ${state.settings.moviesDir} and they’ll appear here automatically.`),
          h('button.btn.btn-secondary', { onClick: () => rescan(false) }, UI.icon('refresh'), h('span', 'Rescan now'))
        )
      );
    } else {
      const pitems = pageItems(items);
      const featured = pickFeatured(pitems.length ? pitems : items);
      const rowOpts = { onSeeAll: openList };
      body = h('div.home-body',
        UI.renderHero(featured, { onPlay: handlers.onPlay, onInfo: handlers.onOpen }),
        h('div.rows',
          renderBrowseBar(),
          pitems.length
            ? pageRows(pitems, handlers, rowOpts)
            : h('div.empty', h('p', state.page === 'shows' ? 'No series found yet. Episodes are detected from S01E02-style names or a "TV SERIES" folder.' : 'No movies found yet.'))
        )
      );
    }

    const home = h('div.home', topbar, banners, body);
    UI.clear(viewEl);
    viewEl.appendChild(home);
    viewEl.appendChild(renderSidebar());
    home.scrollTop = scrollY;
    home.addEventListener('scroll', () => topbar.classList.toggle('is-scrolled', home.scrollTop > 20), { passive: true });
    topbar.classList.toggle('is-scrolled', scrollY > 20 || Boolean(q));
    renderProgress();
    renderBanners();
    startHeroRotation();
    if ((q || state.focusSearch) && document.activeElement !== searchInput) {
      searchInput.focus();
      searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
    }
    state.focusSearch = false;
    if (!window.__firstRenderAt) window.__firstRenderAt = performance.now();
  }

  function openList(title, items) {
    state.listView = { title, ids: items.map((m) => m.id) };
    state.view = 'list';
    render();
  }

  function renderList() {
    const { bar: topbar } = renderTopbar();
    const all = new Map(allItems().map((m) => [m.id, m]));
    const items = state.listView.ids.map((id) => all.get(id)).filter(Boolean);
    const page = h('div.home',
      topbar,
      h('div.home-body.home-search',
        h('h2.row-title',
          h('button.iconbtn', { title: 'Back', onClick: () => { state.view = 'home'; state.listView = null; render(); } }, UI.icon('back')),
          state.listView.title, h('span.row-count', String(items.length))),
        UI.renderGrid(items, handlers)
      )
    );
    UI.clear(viewEl);
    viewEl.appendChild(page);
    viewEl.appendChild(renderSidebar());
    topbar.classList.add('is-scrolled');
  }

  // ---------- remote / keyboard "back" ----------
  // Esc (or a controller's B button, which components/remote.js turns into Esc) walks back:
  // modals and the player handle their own Esc; this covers list -> home, settings -> home, clear search.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' && e.key !== 'Backspace') return;
    if (e.key === 'Backspace' && e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (!document.getElementById('overlay').hidden || state.view === 'player') return;
    if (state.view === 'list') { state.view = 'home'; state.listView = null; render(); }
    else if (state.view === 'settings' && !state.firstRun) { state.view = 'home'; render(); }
    else if (state.view === 'home' && (state.query || state.searchOpen)) { state.query = ''; state.searchOpen = false; renderHome(); }
  });
  if (UI.remote) UI.remote.search = toggleSearch;
  if (UI.remote) UI.remote.home = () => setPage('home');

  load().catch((err) => {
    UI.clear(viewEl);
    viewEl.appendChild(h('div.empty.empty-large', h('h2', 'Something went wrong'), h('p.mono', err.message), h('button.btn.btn-secondary', { onClick: () => location.reload() }, 'Reload')));
  });
})();
