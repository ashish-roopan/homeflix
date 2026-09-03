'use strict';
window.UI = window.UI || {};

/** Big banner at the top of Home for one featured movie. */
UI.renderHero = function renderHero(movie, { onPlay, onInfo }) {
  const { h } = UI;
  if (!movie) return h('div.hero.hero-empty');
  const t = movie.tmdb || {};
  const meta = [
    UI.displayYear(movie),
    t.rating ? `★ ${t.rating.toFixed(1)}` : null,
    UI.fmtRuntime(t.runtime),
    (t.genres || []).slice(0, 3).join(' · ') || null,
  ].filter(Boolean);

  const isShow = movie.kind === 'show';
  const next = isShow && movie.playback && movie.playback.next;
  const resume = isShow ? Boolean(next && movie.playback.started) : movie.playback && movie.playback.position > 0 && !movie.playback.finished;
  const playLabel = movie.missing ? 'File missing'
    : isShow ? (!next ? 'All watched' : resume ? `Resume ${UI.episodeShortLabel(next)}` : 'Play')
    : resume ? 'Resume' : 'Play';
  if (isShow) meta.splice(1, 0, `${movie.seasonCount} season${movie.seasonCount === 1 ? '' : 's'}`);

  return h('section.hero',
    h('div.hero-backdrop', {
      style: movie.backdropUrl
        ? { backgroundImage: `url("${movie.backdropUrl}")` }
        : movie.posterUrl
          ? { backgroundImage: `url("${movie.posterUrl}")`, filter: 'blur(30px) brightness(0.5)', transform: 'scale(1.2)' }
          : {},
    }),
    h('div.hero-shade'),
    h('div.hero-content',
      isShow ? h('div.kind-tag', 'SERIES') : null,
      movie.downloading ? h('div.hero-flag', h('span.spinner.spinner-small'), 'Downloading') : null,
      h('h1.hero-title', UI.displayTitle(movie)),
      meta.length ? h('div.hero-meta', meta.map((m, i) => [i ? h('span.dot', '•') : null, h('span', m)])) : null,
      t.overview ? h('p.hero-overview', t.overview) : h('p.hero-overview.muted', movie.fileName),
      h('div.hero-actions',
        h('button.btn.btn-primary.btn-large', { disabled: movie.missing || (isShow && !next), onClick: () => onPlay(movie) }, UI.icon('play'), h('span', playLabel)),
        h('button.btn.btn-glass.btn-large', { onClick: () => onInfo(movie) }, UI.icon('info'), h('span', 'More info'))
      )
    )
  );
};
