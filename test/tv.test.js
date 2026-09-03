'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fsp = require('fs/promises');
const { parseMediaPath } = require('../src/main/services/parser');
const { Store } = require('../src/main/services/store');
const { LibraryService, showPlayback } = require('../src/main/services/library');
const { buildSmallTree, sparseFile, tmpDir, mockTmdb, MiB } = require('./fixtures');

const ROOT = '/lib';
const ep = (rel, title, year, season, episode, extra = {}) => [rel, { kind: 'episode', title, year, season, episode, ...extra }];
const mov = (rel, title, year) => [rel, { kind: 'movie', title, year }];

const cases = [
  ep('Breaking Bad/Season 1/Breaking.Bad.S01E01.1080p.BluRay.x264.mkv', 'Breaking Bad', null, 1, 1),
  ep('Breaking Bad/Breaking.Bad.S01E02.Cat.in.the.Bag.720p.mkv', 'Breaking Bad', null, 1, 2, { episodeTitle: 'Cat in the Bag' }),
  ep('Dark (2017)/Season 2/03 - Ghosts.mkv', 'Dark', 2017, 2, 3, { episodeTitle: 'Ghosts' }),
  ep('Dark (2017)/S03/E04.mkv', 'Dark', 2017, 3, 4),
  ep('The.Office.US.S02.1080p.WEB-DL/The.Office.US.S02E05.mkv', 'The Office US', null, 2, 5),
  ep('Stranger.Things.S04E01E02.2160p.mkv', 'Stranger Things', null, 4, 1, { episodeEnd: 2 }),
  ep('Sherlock/Series 2/Sherlock - 2x01 - A Scandal in Belgravia.mkv', 'Sherlock', null, 2, 1, { episodeTitle: 'A Scandal in Belgravia' }),
  ep('One Piece/One Piece - 1015 [1080p].mkv', 'One Piece', null, 1, 1015),
  ep('Attack on Titan/[SubsPlease] Attack on Titan - 05 (1080p).mkv', 'Attack on Titan', null, 1, 5),
  ep('Friends/Season 3 - 1080p/Friends.1994.S03E07.mkv', 'Friends', 1994, 3, 7),
  ep('Game of Thrones/Specials/Game.of.Thrones.S00E01.mkv', 'Game of Thrones', null, 0, 1),
  ep('Mirzapur (2018) Hindi S01 Complete 1080p/Mirzapur.S01E03.Hindi.1080p.mkv', 'Mirzapur', 2018, 1, 3),
  ep('The Boys/Season 1/Episode 4.mkv', 'The Boys', null, 1, 4),
  ep('www.Site.tld - Panchayat (2020) S03E02 Hindi 1080p.mkv.part', 'Panchayat', 2020, 3, 2),
  ep('Ted Lasso/Season 1 Episode 2.mkv', 'Ted Lasso', null, 1, 2),
  ep('Chernobyl/Chernobyl.S01E01.1.23.45.mkv', 'Chernobyl', null, 1, 1),
  ep('Kota Factory/Season 1/Kota Factory S01E01 Hindi 1080p.mkv', 'Kota Factory', null, 1, 1),
  ep('Severance (2022)/Season 01/Severance.S01E09.The.We.We.Are.2160p.mkv', 'Severance', 2022, 1, 9, { episodeTitle: 'The We We Are' }),
  // movies must stay movies
  mov('The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv', 'The Matrix', 1999),
  mov('Inception (2010) [1080p] [YTS.MX]/Inception.2010.1080p.mp4', 'Inception', 2010),
  mov('Oppenheimer (2023)/movie.mkv', 'Oppenheimer', 2023),
  mov('Interstellar/CD1.avi', 'Interstellar', null),
  mov('2012.2009.720p.avi', '2012', 2009),
  mov('Blade.Runner.2049.2017.2160p.mkv', 'Blade Runner 2049', 2017),
  mov('Dhamaal 4 (2026) Hindi DVDScr.mkv', 'Dhamaal 4', 2026),
  mov('Se7en.1995.mkv', 'Se7en', 1995),
  mov('Ocean\'s Eleven (2001)/Oceans.Eleven.2001.1080p.mkv', 'Oceans Eleven', 2001),
  // movies nested in arbitrary category folders
  mov('Movies/Hindi/Action/Dhamaal 4 (2026)/movie.mkv', 'Dhamaal 4', 2026),
  mov('Movies/English/Inception.2010.1080p.mkv', 'Inception', 2010),
  mov('Downloads/2023/Oppenheimer.2023.2160p.mkv', 'Oppenheimer', 2023),
  mov('Downloads/2023/Her.mkv', 'Her', null),
  mov('Movies/Malayalam/Premalu 2024 1080p HQ HDRip/Premalu.2024.1080p.mkv', 'Premalu', 2024),
  mov('Movies/Action/Part 2/John.Wick.Chapter.2.2017.mkv', 'John Wick Chapter 2', 2017),
  mov('Collections/Nolan/Interstellar (2014)/Interstellar.mkv', 'Interstellar', 2014),
  // shows nested under category folders
  ep('TV Shows/Breaking Bad/Season 1/Breaking.Bad.S01E01.mkv', 'Breaking Bad', null, 1, 1),
  ep('Series/English/Dark (2017)/Season 1/03.mkv', 'Dark', 2017, 1, 3),
  ep('TV/Hindi/Panchayat/Season 2/Panchayat.S02E04.Hindi.mkv', 'Panchayat', null, 2, 4),
];

for (const [rel, want] of cases) {
  test(`media parse: ${rel}`, () => {
    const r = parseMediaPath(path.join(ROOT, rel), ROOT);
    assert.equal(r.kind, want.kind);
    if (want.kind === 'episode') {
      assert.equal(r.show.title, want.title);
      assert.equal(r.show.year, want.year);
      assert.equal(r.season, want.season);
      assert.equal(r.episode, want.episode);
      if ('episodeEnd' in want) assert.equal(r.episodeEnd, want.episodeEnd);
      if ('episodeTitle' in want) assert.equal(r.episodeTitle, want.episodeTitle);
    } else {
      assert.equal(r.title, want.title);
      assert.equal(r.year, want.year);
    }
  });
}

// ---------------------------------------------------------------- library

async function setup(files) {
  const tree = await buildSmallTree(files);
  const userData = await tmpDir('ml-ud-tv-');
  const store = new Store(userData);
  await store.init();
  await store.saveSettings({ moviesDir: tree.root, tmdbApiKey: 'k', minFileSizeMB: 0 });
  const events = [];
  const tmdb = mockTmdb();
  const lib = new LibraryService(store, tmdb, (channel, payload) => events.push({ channel, payload }));
  const cleanup = async () => {
    lib.dispose();
    await store.flush();
    await tree.cleanup();
    await fsp.rm(userData, { recursive: true, force: true });
  };
  return { tree, userData, store, tmdb, lib, events, cleanup };
}

const SHOW_TREE = {
  'Breaking Bad/Season 1/Breaking.Bad.S01E01.mkv': 60 * MiB,
  'Breaking Bad/Season 1/Breaking.Bad.S01E02.mkv': 61 * MiB,
  'Breaking Bad/Season 2/Breaking.Bad.S02E01.mkv': 62 * MiB,
  'Dark (2017)/Dark.S01E01.mkv': 63 * MiB,
  'The.Matrix.1999.1080p.mkv': 64 * MiB,
};

test('library: episodes group into shows, one TV lookup per show, one season fetch per season', async (t) => {
  const s = await setup(SHOW_TREE);
  t.after(s.cleanup);
  await s.lib.scan();
  const pub = s.lib.publicLibrary();
  assert.equal(pub.movies.length, 1, 'only the movie is in movies');
  assert.equal(pub.shows.length, 2);
  const bb = pub.shows.find((x) => x.parsed.title === 'Breaking Bad');
  assert.equal(bb.status, 'matched');
  assert.equal(bb.seasonCount, 2);
  assert.equal(bb.episodeCount, 3);
  assert.deepEqual(bb.seasons.map((x) => x.number), [1, 2]);
  assert.equal(bb.seasons[0].episodes[1].name, 'Episode 2 of S1', 'episode names come from season details');
  assert.ok(bb.posterUrl && bb.posterUrl.startsWith('media://img/posters/tv'));
  assert.equal(s.tmdb.calls.tvSearch, 2, 'one search per show');
  assert.equal(s.tmdb.calls.tvDetails, 2);
  assert.equal(s.tmdb.calls.seasons, 3, 'S1+S2 for Breaking Bad, S1 for Dark');
  assert.equal(s.tmdb.calls.search, 1, 'movie searched once');

  // rescan: nothing new
  await s.lib.scan();
  assert.equal(s.tmdb.calls.tvSearch, 2);
  assert.equal(s.tmdb.calls.seasons, 3);

  // new episode in an existing season: no network at all
  await sparseFile(path.join(s.tree.root, 'Breaking Bad/Season 1/Breaking.Bad.S01E03.mkv'), 65 * MiB);
  await s.lib.scan();
  assert.equal(s.tmdb.calls.tvSearch, 2);
  assert.equal(s.tmdb.calls.seasons, 3);
  assert.equal(s.lib.publicLibrary().shows.find((x) => x.parsed.title === 'Breaking Bad').episodeCount, 4);

  // new season: one season fetch, no search
  await sparseFile(path.join(s.tree.root, 'Breaking Bad/Season 3/Breaking.Bad.S03E01.mkv'), 66 * MiB);
  await s.lib.scan();
  assert.equal(s.tmdb.calls.tvSearch, 2);
  assert.equal(s.tmdb.calls.seasons, 4);
});

test('library: removing all episodes removes the show; a season TMDB lacks gets a stub', async (t) => {
  const s = await setup({ 'Odd Show/Odd.Show.S09E01.mkv': 60 * MiB, 'Gone Show/Gone.Show.S01E01.mkv': 61 * MiB });
  t.after(s.cleanup);
  await s.lib.scan();
  let pub = s.lib.publicLibrary();
  assert.equal(pub.shows.length, 2);
  const odd = pub.shows.find((x) => x.parsed.title === 'Odd Show');
  assert.equal(odd.status, 'matched');
  assert.equal(odd.seasons[0].episodes[0].name, null, 'no episode name when TMDB has no such season');
  await fsp.rm(path.join(s.tree.root, 'Gone Show'), { recursive: true });
  await s.lib.scan();
  pub = s.lib.publicLibrary();
  assert.deepEqual(pub.shows.map((x) => x.parsed.title), ['Odd Show']);
});

test('library: show playback aggregates to "next episode"; fixMatchShow re-keys metadata', async (t) => {
  const s = await setup(SHOW_TREE);
  t.after(s.cleanup);
  await s.lib.scan();
  let bb = s.lib.publicLibrary().shows.find((x) => x.parsed.title === 'Breaking Bad');
  assert.equal(bb.playback.started, false);
  assert.equal(bb.playback.next.episode, 1);
  const e1 = bb.seasons[0].episodes[0];
  const e2 = bb.seasons[0].episodes[1];
  // half-way through E1 -> resume E1
  s.lib.savePosition(e1.id, 600, 2700);
  bb = s.lib.publicLibrary().shows.find((x) => x.parsed.title === 'Breaking Bad');
  assert.equal(bb.playback.nextEpisodeId, e1.id);
  assert.equal(bb.playback.position, 600);
  // finished E1 -> next is E2
  s.lib.savePosition(e1.id, 2690, 2700);
  bb = s.lib.publicLibrary().shows.find((x) => x.parsed.title === 'Breaking Bad');
  assert.equal(bb.playback.nextEpisodeId, e2.id);
  assert.equal(bb.playback.finished, false);
  // finished the last one -> finished
  const last = bb.seasons[1].episodes[0];
  s.lib.savePosition(last.id, 2690, 2700);
  bb = s.lib.publicLibrary().shows.find((x) => x.parsed.title === 'Breaking Bad');
  assert.equal(bb.playback.finished, true);

  const fixed = await s.lib.fixMatchShow(bb.key, 777);
  assert.equal(fixed.tmdb.id, 777);
  assert.equal(fixed.manualMatch, true);
  assert.equal(s.tmdb.calls.seasons, 5, 'seasons re-fetched for the new id');
  await s.lib.scan({ force: true });
  assert.equal(s.lib.publicLibrary().shows.find((x) => x.parsed.title === 'Breaking Bad').tmdb.id, 777, 'manual show match survives');
});

test('library: a lone "Title - 01" file in a movie folder stays a movie', async (t) => {
  const s = await setup({ 'Movie Name (2021)/Movie Name - 01.mkv': 60 * MiB, 'Anime/Anime - 01.mkv': 60 * MiB, 'Anime/Anime - 02.mkv': 61 * MiB });
  t.after(s.cleanup);
  await s.lib.scan();
  const pub = s.lib.publicLibrary();
  assert.deepEqual(pub.movies.map((m) => m.parsed.title), ['Movie Name']);
  assert.deepEqual(pub.shows.map((x) => [x.parsed.title, x.episodeCount]), [['Anime', 2]]);
});

test('library: unmatched show retried on force; no key leaves episodes unmatched not pending', async (t) => {
  const s = await setup({ 'Zzz Show/Zzz.Show.S01E01.mkv': 60 * MiB });
  t.after(s.cleanup);
  s.tmdb.unknownTitles.add('Zzz Show');
  await s.lib.scan();
  let sh = s.lib.publicLibrary().shows[0];
  assert.equal(sh.status, 'unmatched');
  assert.equal(sh.seasons[0].episodes[0].status, 'unmatched');
  await s.lib.scan();
  assert.equal(s.tmdb.calls.tvSearch, 1, 'not retried on a normal rescan');
  s.tmdb.unknownTitles.clear();
  await s.lib.scan({ force: true });
  sh = s.lib.publicLibrary().shows[0];
  assert.equal(sh.status, 'matched');
});

test('showPlayback helper edge cases', () => {
  assert.equal(showPlayback([]), null);
  const eps = [
    { id: 'a', season: 1, episode: 1, playback: { finished: true, lastPlayedAt: '2020-01-01', position: 0, duration: 10 } },
    { id: 'b', season: 1, episode: 2, playback: null },
  ];
  assert.equal(showPlayback(eps).nextEpisodeId, 'b');
});
