'use strict';
window.UI = window.UI || {};

const CARD_W = 200 + 8; // card width + gap, kept in sync with --card-w in styles.css
const ROW_CAP = 100;

/** One poster card. */
UI.renderCard = function renderCard(movie, { onOpen, onPlay }) {
  const { h } = UI;
  const title = UI.displayTitle(movie);
  const year = UI.displayYear(movie);
  const pct = UI.progressPct(movie);
  const unmatched = movie.status !== 'matched';

  const isShow = movie.kind === 'show';
  let badge = null;
  if (movie.missing) badge = h('div.card-badge.card-badge-warn', 'File missing');
  else if (movie.downloading) badge = h('div.card-badge.card-badge-dl', h('span.spinner.spinner-small'), 'Downloading');
  else if (movie.status === 'pending') badge = h('div.card-badge.card-badge-pending', 'Matching…');
  else if (unmatched && UI.hasTmdbKey) badge = h('div.card-badge', 'Fix match'); // only meaningful once a lookup was possible
  const kindTag = isShow ? h('div.card-kind', 'SERIES') : null;
  const sub = isShow
    ? [year, `${movie.seasonCount} season${movie.seasonCount === 1 ? '' : 's'}`, movie.tmdb && movie.tmdb.rating ? `★ ${movie.tmdb.rating.toFixed(1)}` : null]
    : [year, movie.tmdb && movie.tmdb.rating ? `★ ${movie.tmdb.rating.toFixed(1)}` : null];
  const canPlay = !movie.missing && !(isShow && movie.playback && !movie.playback.next);
  const nextLabel = isShow && movie.playback && movie.playback.next && movie.playback.started ? UI.episodeShortLabel(movie.playback.next) : null;

  const card = h('article.card', {
    tabindex: 0,
    dataset: { id: movie.id },
    title: movie.fileName,
    onClick: () => onOpen(movie),
    onKeydown: (e) => {
      if (e.key === 'Enter') onOpen(movie);
      if (e.key === ' ') {
        e.preventDefault();
        onPlay(movie);
      }
    },
  },
    h('div.card-poster',
      movie.posterUrl
        ? h('img', { src: movie.posterUrl, alt: title, loading: 'lazy', draggable: false, onError: (e) => { e.target.replaceWith(UI.placeholder(title, year)); } })
        : UI.placeholder(title, year),
      badge,
      kindTag,
      movie.dupCount > 1 ? h('div.card-badge.card-badge-count', `${movie.dupCount} files`) : null,
      nextLabel ? h('div.card-badge.card-badge-count.card-next', nextLabel) : null,
      pct ? h('div.card-progress', h('div.card-progress-bar', { style: { width: `${pct}%` } })) : null,
      canPlay ? h('button.card-play', { 'aria-label': 'Play', onClick: (e) => { e.stopPropagation(); onPlay(movie); } }, UI.icon('play')) : null
    ),
    h('div.card-caption',
      h('div.card-title', title),
      h('div.card-sub', sub.filter(Boolean).join('  ·  '))
    )
  );
  return card;
};

UI.placeholder = (title, year) => {
  const { h } = UI;
  return h('div.card-placeholder',
    UI.icon('film'),
    h('div.card-placeholder-title', title),
    year ? h('div.card-placeholder-year', String(year)) : null
  );
};

/**
 * A horizontally scrolling row with chevrons. Cards are materialised lazily as
 * the user scrolls, and very long rows are capped with a "See all" tile.
 */
UI.renderRow = function renderRow(label, movies, handlers, { onSeeAll, min = 1, hint } = {}) {
  const { h } = UI;
  if (!movies || movies.length < Math.max(1, min)) return null;
  const capped = movies.length > ROW_CAP;
  const list = capped ? movies.slice(0, ROW_CAP) : movies;
  const initial = Math.min(list.length, Math.ceil(window.innerWidth / CARD_W) + 4);

  const track = h('div.row-track');
  let rendered = 0;
  const sentinel = h('div.row-sentinel');
  const renderMore = (n) => {
    const frag = document.createDocumentFragment();
    const end = Math.min(list.length, rendered + n);
    for (; rendered < end; rendered++) frag.appendChild(UI.renderCard(list[rendered], handlers));
    track.insertBefore(frag, sentinel);
    if (rendered >= list.length) {
      sentinel.remove();
      if (capped && onSeeAll) {
        track.appendChild(
          h('button.card.card-more', { onClick: () => onSeeAll(label, movies) },
            h('div.card-poster', h('div.card-placeholder', h('div.card-more-count', `+${movies.length - ROW_CAP}`), h('div', 'See all'))),
            h('div.card-caption', h('div.card-title', `${movies.length} titles`))
          )
        );
      }
    }
  };
  track.appendChild(sentinel);
  renderMore(initial);
  if (rendered < list.length && typeof IntersectionObserver !== 'undefined') {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        renderMore(12);
        if (rendered >= list.length) io.disconnect();
      }
    }, { root: track, rootMargin: '0px 600px 0px 0px' });
    io.observe(sentinel);
  }

  const scrollBy = (dir) => track.scrollBy({ left: dir * track.clientWidth * 0.85, behavior: 'smooth' });
  const left = h('button.row-chevron.row-chevron-left', { 'aria-label': 'Scroll left', onClick: () => scrollBy(-1) }, UI.icon('left'));
  const right = h('button.row-chevron.row-chevron-right', { 'aria-label': 'Scroll right', onClick: () => scrollBy(1) }, UI.icon('right'));
  const update = () => {
    left.classList.toggle('is-hidden', track.scrollLeft <= 4);
    right.classList.toggle('is-hidden', track.scrollLeft + track.clientWidth >= track.scrollWidth - 4);
  };
  track.addEventListener('scroll', update, { passive: true });
  requestAnimationFrame(update);

  return h('section.row', { dataset: { row: label } },
    h('h2.row-title', label, h('span.row-count', String(movies.length)), hint ? h('span.row-hint', hint) : null, capped && onSeeAll ? h('button.row-seeall', { onClick: () => onSeeAll(label, movies) }, 'See all') : null),
    h('div.row-body', left, track, right)
  );
};

/** Responsive grid of cards, paged so 5000 titles don't hit the DOM at once. */
UI.renderGrid = function renderGrid(movies, handlers, { pageSize = 200 } = {}) {
  const { h } = UI;
  const grid = h('div.grid');
  let shown = 0;
  const more = h('button.btn.btn-glass.grid-more', { onClick: () => addPage() }, 'Show more');
  const wrap = h('div.grid-wrap', grid);
  const addPage = () => {
    const frag = document.createDocumentFragment();
    const end = Math.min(movies.length, shown + pageSize);
    for (; shown < end; shown++) frag.appendChild(UI.renderCard(movies[shown], handlers));
    grid.appendChild(frag);
    if (shown < movies.length) {
      more.textContent = `Show more (${movies.length - shown} left)`;
      if (!more.isConnected) wrap.appendChild(more);
    } else more.remove();
  };
  addPage();
  return wrap;
};
