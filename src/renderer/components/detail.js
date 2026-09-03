'use strict';
window.UI = window.UI || {};

/** Detail modal for one movie, with fix-match search inside it. */
UI.openDetail = function openDetail(movie, { onPlay, onChanged, onRescan }) {
  const { h } = UI;
  const overlay = document.getElementById('overlay');
  const t = movie.tmdb || {};
  const title = UI.displayTitle(movie);
  const year = UI.displayYear(movie);
  const resume = movie.playback && movie.playback.position > 0 && !movie.playback.finished;
  const files = [movie, ...(movie.dupes || [])];
  const fail = (err) => UI.toast(err.message, { kind: 'error' });

  const close = () => {
    overlay.hidden = true;
    UI.clear(overlay);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);

  // ---- fix match panel ----
  const fixInput = h('input.fix-input', { type: 'search', placeholder: 'Search TMDB by title…', value: movie.parsed.title || '' });
  const fixYear = h('input.fix-input.fix-year', { type: 'number', placeholder: 'Year', value: movie.parsed.year || '' });
  const fixResults = h('div.fix-results');
  const fixPanel = h('div.fix-panel', { hidden: movie.status === 'matched' },
    h('div.fix-head', h('strong', movie.status === 'matched' ? 'Not the right movie?' : movie.status === 'pending' ? 'Still identifying this file…' : 'We couldn’t identify this file.'), h('span.muted', ` File: ${movie.fileName}`)),
    h('div.fix-form', fixInput, fixYear, h('button.btn.btn-secondary', { onClick: () => runSearch() }, UI.icon('search'), h('span', 'Search'))),
    fixResults
  );

  async function runSearch() {
    UI.clear(fixResults);
    fixResults.appendChild(h('div.muted', 'Searching…'));
    try {
      const results = await window.api.searchTmdb(fixInput.value, fixYear.value ? Number(fixYear.value) : undefined);
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
        : err.kind === 'INVALID_API_KEY' ? 'TMDB rejected the API key. Check it in Settings.'
        : err.message;
      fixResults.appendChild(h('div.settings-error', msg));
    }
  }
  async function apply(tmdbId) {
    try {
      const updated = await window.api.fixMatch(movie.id, tmdbId);
      UI.toast(`Matched to “${updated.tmdb.title}”`);
      close();
      onChanged(updated);
    } catch (err) {
      fail(err);
    }
  }
  fixInput.addEventListener('keydown', (e) => e.key === 'Enter' && runSearch());
  fixYear.addEventListener('keydown', (e) => e.key === 'Enter' && runSearch());

  const meta = [
    year,
    t.rating ? `★ ${t.rating.toFixed(1)}` : null,
    UI.fmtRuntime(t.runtime),
    UI.fmtSize(movie.size),
  ].filter(Boolean);

  const statusLine = movie.missing
    ? h('div.status-line.status-warn', UI.icon('warn'), h('span', 'The file can’t be found. Was it moved or deleted?'), h('button.btn.btn-ghost.btn-small', { onClick: () => onRescan && onRescan() }, 'Rescan'))
    : movie.downloading
      ? h('div.status-line', h('span.spinner.spinner-small'), h('span', movie.partial ? 'Download in progress. You can start watching, but seeking near the end may not work yet.' : 'This file is still being written to.'))
      : null;

  const modal = h('div.modal', { role: 'dialog', 'aria-modal': true },
    h('div.modal-hero', {
      style: movie.backdropUrl ? { backgroundImage: `url("${movie.backdropUrl}")` } : {},
    },
      h('div.modal-hero-shade'),
      h('button.modal-close', { 'aria-label': 'Close', onClick: close }, UI.icon('close')),
      h('div.modal-hero-content',
        movie.posterUrl ? h('img.modal-poster', { src: movie.posterUrl, alt: '', onError: (e) => e.target.remove() }) : null,
        h('div.modal-headline',
          h('h2.modal-title', title),
          t.tagline ? h('div.modal-tagline', t.tagline) : null,
          h('div.modal-meta', meta.map((m, i) => [i ? h('span.dot', '•') : null, h('span', m)])),
          h('div.modal-actions',
            h('button.btn.btn-primary.btn-large', { disabled: movie.missing, onClick: () => { close(); onPlay(movie); } }, UI.icon('play'), h('span', resume ? `Resume at ${UI.fmtTime(movie.playback.position)}` : 'Play')),
            h('button.btn.btn-glass', { disabled: movie.missing, onClick: () => window.api.openExternal(movie.id).catch(fail) }, UI.icon('external'), h('span', 'Open in external player')),
            h('button.btn.btn-glass', { onClick: () => window.api.revealInFinder(movie.id).catch(fail) }, UI.icon('folder'), h('span', UI.revealLabel))
          )
        )
      )
    ),
    h('div.modal-body',
      h('div.modal-main',
        statusLine,
        t.overview ? h('p.modal-overview', t.overview) : h('p.modal-overview.muted', 'No description available.'),
        fixPanel
      ),
      h('aside.modal-side',
        t.genres && t.genres.length ? h('div.modal-fact', h('span.muted', 'Genres: '), t.genres.join(', ')) : null,
        (() => {
          const codes = [...new Set([t.originalLanguage, ...((movie.parsed && movie.parsed.languages) || [])].filter(Boolean))];
          if (!codes.length) return null;
          let names;
          try { const dn = new Intl.DisplayNames(['en'], { type: 'language' }); names = codes.map((c) => { const n = dn.of(c); return n && n !== c ? n : c.toUpperCase(); }); } catch { names = codes.map((c) => c.toUpperCase()); }
          return h('div.modal-fact', h('span.muted', codes.length > 1 ? 'Languages: ' : 'Language: '), names.join(', '));
        })(),
        h('div.modal-fact', h('span.muted', files.length > 1 ? `${files.length} files: ` : 'File: '),
          files.length > 1
            ? h('ul.modal-files', files.map((f) => h('li', h('span.mono', f.fileName), h('span.muted', ` (${UI.fmtSize(f.size)})`), f.id !== movie.id ? h('button.btn.btn-ghost.btn-small', { onClick: () => { close(); onPlay(f); } }, 'Play this') : null)))
            : h('span.mono', movie.fileName)),
        movie.parsed.title ? h('div.modal-fact', h('span.muted', 'Parsed as: '), `${movie.parsed.title}${movie.parsed.year ? ` (${movie.parsed.year})` : ''}`) : null,
        movie.status === 'matched'
          ? h('button.btn.btn-ghost.btn-small', { onClick: () => { fixPanel.hidden = !fixPanel.hidden; if (!fixPanel.hidden) fixInput.focus(); } }, 'Wrong movie? Fix match')
          : null
      )
    )
  );

  UI.clear(overlay);
  overlay.appendChild(modal);
  overlay.hidden = false;
  overlay.onclick = (e) => e.target === overlay && close();
  if (movie.status === 'unmatched') runSearch();
};
