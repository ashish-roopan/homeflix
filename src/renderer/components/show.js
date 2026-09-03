'use strict';
window.UI = window.UI || {};

UI.episodeLabel = (e) => `S${e.season} · E${e.episode}${e.episodeEnd ? `–${e.episodeEnd}` : ''}`;
UI.episodeShortLabel = (e) => `S${e.season} E${e.episode}${e.episodeEnd ? `-${e.episodeEnd}` : ''}`;

/** Detail modal for a TV show: seasons, episodes, next up, fix match. */
UI.openShowDetail = function openShowDetail(show, { onPlayEpisode, onChanged, onRescan }) {
  const { h } = UI;
  const overlay = document.getElementById('overlay');
  const t = show.tmdb || {};
  const title = show.title || show.parsed.title;
  const fail = (err) => UI.toast(err.message, { kind: 'error' });
  const next = show.playback && show.playback.next;

  const close = () => {
    overlay.hidden = true;
    UI.clear(overlay);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);

  // ---- fix match panel ----
  const fixInput = h('input.fix-input', { type: 'search', placeholder: 'Search TMDB for the show…', value: show.parsed.title || '' });
  const fixYear = h('input.fix-input.fix-year', { type: 'number', placeholder: 'Year', value: show.parsed.year || '' });
  const fixResults = h('div.fix-results');
  const fixPanel = h('div.fix-panel', { hidden: show.status === 'matched' },
    h('div.fix-head', h('strong', show.status === 'matched' ? 'Not the right show?' : show.status === 'pending' ? 'Still identifying this show…' : 'We couldn’t identify this show.'), h('span.muted', ` Folder: ${show.fileName}`)),
    h('div.fix-form', fixInput, fixYear, h('button.btn.btn-secondary', { onClick: () => runSearch() }, UI.icon('search'), h('span', 'Search'))),
    fixResults
  );
  async function runSearch() {
    UI.clear(fixResults);
    fixResults.appendChild(h('div.muted', 'Searching…'));
    try {
      const results = await window.api.searchTv(fixInput.value, fixYear.value ? Number(fixYear.value) : undefined);
      UI.clear(fixResults);
      if (!results.length) return fixResults.appendChild(h('div.muted', 'No results. Try fewer words or drop the year.'));
      results.slice(0, 12).forEach((r) => {
        fixResults.appendChild(
          h('button.fix-result', { onClick: () => apply(r.id) },
            r.posterPath ? h('img', { src: `https://image.tmdb.org/t/p/w92${r.posterPath}`, alt: '', onError: (e) => e.target.replaceWith(h('div.fix-result-noimg', UI.icon('film'))) }) : h('div.fix-result-noimg', UI.icon('film')),
            h('div.fix-result-text',
              h('div.fix-result-title', r.title, r.year ? h('span.muted', ` (${r.year})`) : null),
              h('div.fix-result-overview', r.overview)
            )
          )
        );
      });
    } catch (err) {
      UI.clear(fixResults);
      const msg = err.kind === 'NO_API_KEY' ? 'Add a TMDB API key in Settings to search.'
        : err.kind === 'NETWORK' ? 'TMDB is unreachable right now. Check your connection and try again.'
        : err.message;
      fixResults.appendChild(h('div.settings-error', msg));
    }
  }
  async function apply(tmdbId) {
    try {
      const updated = await window.api.fixMatchShow(show.key, tmdbId);
      UI.toast(`Matched to “${updated.title}”`);
      close();
      onChanged(updated);
    } catch (err) {
      fail(err);
    }
  }
  fixInput.addEventListener('keydown', (e) => e.key === 'Enter' && runSearch());
  fixYear.addEventListener('keydown', (e) => e.key === 'Enter' && runSearch());

  // ---- seasons / episodes ----
  let currentSeason = next ? next.season : show.seasons[0] && show.seasons[0].number;
  const seasonTabs = h('div.season-tabs');
  const episodeList = h('div.episode-list');

  function renderSeasonTabs() {
    UI.clear(seasonTabs);
    for (const s of show.seasons) {
      seasonTabs.appendChild(h('button.chip', { class: `chip${s.number === currentSeason ? ' is-active' : ''}`, onClick: () => { currentSeason = s.number; renderSeasonTabs(); renderEpisodes(); } },
        s.name, h('span.chip-count', String(s.episodes.length))));
    }
  }

  function renderEpisodes() {
    UI.clear(episodeList);
    const season = show.seasons.find((s) => s.number === currentSeason);
    if (!season) return;
    if (season.overview) episodeList.appendChild(h('p.season-overview', season.overview));
    if (season.episodeCount && season.episodeCount > season.episodes.length) {
      episodeList.appendChild(h('div.muted.small.season-note', `You have ${season.episodes.length} of ${season.episodeCount} episodes.`));
    }
    for (const e of season.episodes) {
      const pct = UI.progressPct(e);
      const done = e.playback && e.playback.finished;
      const isNext = next && next.id === e.id;
      episodeList.appendChild(
        h('article.episode', {
          class: `episode${isNext ? ' is-next' : ''}${e.missing ? ' is-missing' : ''}`,
          tabindex: 0,
          onClick: () => !e.missing && onPlayEpisode(e, show),
          onKeydown: (ev) => { if (ev.key === 'Enter' && !e.missing) { ev.preventDefault(); onPlayEpisode(e, show); } },
        },
          h('div.episode-num', String(e.episode)),
          h('div.episode-thumb',
            e.stillUrl ? h('img', { src: e.stillUrl, alt: '', loading: 'lazy', onError: (ev) => ev.target.remove() }) : null,
            e.missing ? null : h('div.episode-play', UI.icon('play')),
            pct ? h('div.card-progress', h('div.card-progress-bar', { style: { width: `${pct}%` } })) : null,
            done ? h('div.episode-done', UI.icon('check')) : null
          ),
          h('div.episode-text',
            h('div.episode-title',
              e.name || `Episode ${e.episode}`,
              e.downloading ? h('span.card-badge.card-badge-dl.inline-badge', h('span.spinner.spinner-small'), 'Downloading') : null,
              e.missing ? h('span.card-badge.card-badge-warn.inline-badge', 'File missing') : null,
              isNext && show.playback.started ? h('span.card-badge.inline-badge', pct ? 'Resume' : 'Next up') : null
            ),
            h('div.episode-meta', [e.runtime ? UI.fmtRuntime(e.runtime) : null, e.airDate ? e.airDate.slice(0, 4) === e.airDate ? e.airDate : new Date(e.airDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null, e.rating ? `★ ${e.rating.toFixed(1)}` : null, UI.fmtSize(e.size)].filter(Boolean).join('  ·  ')),
            e.overview ? h('div.episode-overview', e.overview) : h('div.episode-overview.muted', e.fileName)
          )
        )
      );
    }
  }
  renderSeasonTabs();
  renderEpisodes();

  const meta = [
    t.year ? (t.endYear && t.endYear !== t.year ? `${t.year}–${t.endYear}` : String(t.year)) : show.parsed.year,
    t.rating ? `★ ${t.rating.toFixed(1)}` : null,
    `${show.seasonCount} season${show.seasonCount === 1 ? '' : 's'} · ${show.episodeCount} episode${show.episodeCount === 1 ? '' : 's'}`,
    t.showStatus === 'Ended' ? 'Ended' : null,
  ].filter(Boolean);

  const playLabel = !next ? 'All watched' : show.playback.started ? (show.playback.position > 0 ? `Resume ${UI.episodeShortLabel(next)}` : `Play ${UI.episodeShortLabel(next)}`) : `Play ${UI.episodeShortLabel(next)}`;

  const modal = h('div.modal.modal-show', { role: 'dialog', 'aria-modal': true },
    h('div.modal-hero', { style: show.backdropUrl ? { backgroundImage: `url("${show.backdropUrl}")` } : {} },
      h('div.modal-hero-shade'),
      h('button.modal-close', { 'aria-label': 'Close', onClick: close }, UI.icon('close')),
      h('div.modal-hero-content',
        show.posterUrl ? h('img.modal-poster', { src: show.posterUrl, alt: '', onError: (e) => e.target.remove() }) : null,
        h('div.modal-headline',
          h('div.kind-tag', 'SERIES'),
          h('h2.modal-title', title),
          t.tagline ? h('div.modal-tagline', t.tagline) : null,
          h('div.modal-meta', meta.map((m, i) => [i ? h('span.dot', '•') : null, h('span', m)])),
          h('div.modal-actions',
            h('button.btn.btn-primary.btn-large', { disabled: !next || next.missing, onClick: () => { if (next) { close(); onPlayEpisode(next, show); } } }, UI.icon('play'), h('span', playLabel)),
            h('button.btn.btn-glass', { onClick: () => window.api.revealInFinder(show.seasons[0].episodes[0].id).catch(fail) }, UI.icon('folder'), h('span', UI.revealLabel))
          )
        )
      )
    ),
    h('div.modal-body.modal-body-show',
      h('div.modal-main',
        show.missing ? h('div.status-line.status-warn', UI.icon('warn'), h('span', 'None of this show’s files can be found right now.'), h('button.btn.btn-ghost.btn-small', { onClick: () => onRescan && onRescan() }, 'Rescan')) : null,
        t.overview ? h('p.modal-overview', t.overview) : h('p.modal-overview.muted', 'No description available.'),
        fixPanel,
        h('h3.section-title', 'Episodes'),
        show.seasons.length > 1 ? seasonTabs : null,
        episodeList
      ),
      h('aside.modal-side',
        t.genres && t.genres.length ? h('div.modal-fact', h('span.muted', 'Genres: '), t.genres.join(', ')) : null,
        (() => {
          const codes = [...new Set([t.originalLanguage, ...(show.parsed.languages || [])].filter(Boolean))];
          if (!codes.length) return null;
          let names;
          try { const dn = new Intl.DisplayNames(['en'], { type: 'language' }); names = codes.map((c) => { const n = dn.of(c); return n && n !== c ? n : c.toUpperCase(); }); } catch { names = codes.map((c) => c.toUpperCase()); }
          return h('div.modal-fact', h('span.muted', codes.length > 1 ? 'Languages: ' : 'Language: '), names.join(', '));
        })(),
        t.numberOfSeasons ? h('div.modal-fact', h('span.muted', 'On TMDB: '), `${t.numberOfSeasons} seasons, ${t.numberOfEpisodes || '?'} episodes`) : null,
        h('div.modal-fact', h('span.muted', 'Folder: '), h('span.mono', show.fileName)),
        h('div.modal-fact', h('span.muted', 'Parsed as: '), `${show.parsed.title}${show.parsed.year ? ` (${show.parsed.year})` : ''}`),
        show.status === 'matched'
          ? h('button.btn.btn-ghost.btn-small', { onClick: () => { fixPanel.hidden = !fixPanel.hidden; if (!fixPanel.hidden) fixInput.focus(); } }, 'Wrong show? Fix match')
          : null
      )
    )
  );

  UI.clear(overlay);
  overlay.appendChild(modal);
  overlay.hidden = false;
  overlay.onclick = (e) => e.target === overlay && close();
  if (show.status === 'unmatched') runSearch();
};
