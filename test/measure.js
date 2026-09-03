// Runs inside the app page via MOVIE_LAUNCHER_SCRIPT. Reports render metrics.
const lib = await window.api.getLibrary();
const counts = {};
for (const m of lib.movies) counts[m.status] = (counts[m.status] || 0) + 1;
return {
  firstRenderMs: Math.round(window.__firstRenderAt || -1),
  movies: lib.movies.length,
  status: counts,
  downloading: lib.movies.filter((m) => m.downloading).length,
  cardsInDom: document.querySelectorAll('.card').length,
  rows: [...document.querySelectorAll('.row-title')].map((e) => e.firstChild.textContent + ':' + (e.querySelector('.row-count') || {}).textContent),
  banners: [...document.querySelectorAll('.banner')].map((b) => b.textContent.trim().slice(0, 80)),
  heroTitle: (document.querySelector('.hero-title') || {}).textContent || null,
  usedJSHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
};
