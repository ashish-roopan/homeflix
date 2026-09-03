'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fsp = require('fs/promises');
const { Store } = require('../src/main/services/store');
const { LibraryService, idFor } = require('../src/main/services/library');
const { buildSmallTree, sparseFile, tmpDir, mockTmdb, MiB } = require('./fixtures');

async function setup(files) {
  const tree = await buildSmallTree(files);
  const userData = await tmpDir('ml-ud-');
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

const movies = (lib) => Object.values(lib.library.movies);
const byName = (lib, name) => movies(lib).find((m) => m.fileName === name);
const lastProgress = (events) => [...events].reverse().find((e) => e.channel === 'library:progress').payload;

test('library: initial scan matches everything; rescan makes no TMDB calls', async (t) => {
  const s = await setup({ 'A.Movie.2001.mkv': 60 * MiB, 'B.Movie.2002.mkv': 61 * MiB, 'Sub/C (2003)/movie.mkv': 62 * MiB });
  t.after(s.cleanup);
  await s.lib.scan();
  assert.equal(movies(s.lib).length, 3);
  assert.ok(movies(s.lib).every((m) => m.status === 'matched' && m.posterFile));
  assert.equal(s.tmdb.calls.search, 3);
  await s.lib.scan();
  assert.equal(s.tmdb.calls.search, 3, 'no lookups on a no-change rescan');
  assert.equal(lastProgress(s.events).phase, 'idle');
});

test('library: growing file keeps metadata, is flagged downloading, no re-lookup', async (t) => {
  const s = await setup({ 'Grow.2004.mkv': 60 * MiB });
  t.after(s.cleanup);
  await s.lib.scan();
  const before = byName(s.lib, 'Grow.2004.mkv');
  assert.equal(before.status, 'matched');
  assert.equal(s.tmdb.calls.search, 1);
  // file grows (download in progress)
  await sparseFile(path.join(s.tree.root, 'Grow.2004.mkv'), 90 * MiB);
  await s.lib.scan();
  const after = byName(s.lib, 'Grow.2004.mkv');
  assert.equal(after.status, 'matched');
  assert.ok(after.tmdb, 'tmdb kept');
  assert.equal(after.size, 90 * MiB);
  assert.equal(after.downloading, true);
  assert.equal(s.tmdb.calls.search, 1, 'no new lookups');
  // savePosition near the end of a downloading file must not mark it finished
  const pb = s.lib.savePosition(after.id, 99, 100);
  assert.equal(pb.finished, false);
});

test('library: .part and .mkv share an id; rename .part -> .mkv keeps playback', async (t) => {
  const s = await setup({ 'www.Site.tld - New Film (2020) Hindi HDRip - 400MB.mkv.part': 30 * MiB });
  t.after(s.cleanup);
  await s.lib.scan();
  const partial = movies(s.lib)[0];
  assert.equal(partial.partial, true);
  assert.equal(partial.downloading, true);
  assert.equal(partial.status, 'matched', 'partials still get a poster');
  assert.equal(partial.parsed.title, 'New Film');
  s.lib.savePosition(partial.id, 300, 6000);

  // leftover: complete file appears next to its .part (like Balan The Boy)
  await sparseFile(path.join(s.tree.root, 'www.Site.tld - New Film (2020) Hindi HDRip - 400MB.mkv'), 30 * MiB);
  await s.lib.scan();
  assert.equal(movies(s.lib).length, 1, 'mkv + mkv.part collapse into one entry');
  let m = movies(s.lib)[0];
  assert.equal(m.id, partial.id);
  assert.equal(m.partial, false, 'complete file preferred');
  assert.equal(m.fileName, 'www.Site.tld - New Film (2020) Hindi HDRip - 400MB.mkv');

  // .part removed -> still one entry, same id, playback intact
  await fsp.rm(path.join(s.tree.root, 'www.Site.tld - New Film (2020) Hindi HDRip - 400MB.mkv.part'));
  await s.lib.scan();
  m = movies(s.lib)[0];
  assert.equal(m.id, partial.id);
  assert.equal(s.store.getPlayback(m.id).position, 300);
  assert.equal(s.tmdb.calls.search, 1, 'one lookup total');
});

test('library: same-size rename carries metadata and playback over', async (t) => {
  const s = await setup({ 'Old.Name.2019.mkv': 66 * MiB, 'Other.2018.mkv': 67 * MiB });
  t.after(s.cleanup);
  await s.lib.scan();
  const old = byName(s.lib, 'Old.Name.2019.mkv');
  s.lib.savePosition(old.id, 1234, 5000);
  await fsp.rename(path.join(s.tree.root, 'Old.Name.2019.mkv'), path.join(s.tree.root, 'Renamed (2019).mkv'));
  await s.lib.scan();
  assert.equal(movies(s.lib).length, 2);
  const renamed = byName(s.lib, 'Renamed (2019).mkv');
  assert.ok(renamed);
  assert.notEqual(renamed.id, old.id);
  assert.equal(renamed.status, 'matched');
  assert.equal(renamed.tmdb.id, old.tmdb.id);
  assert.equal(renamed.addedAt, old.addedAt);
  assert.equal(s.store.getPlayback(renamed.id).position, 1234);
  assert.equal(s.store.getPlayback(old.id), null);
  assert.equal(s.lib.library.movies[old.id], undefined);
  assert.equal(s.tmdb.calls.search, 2, 'no lookup for the rename');
});

test('library: deleted file is removed; missing folder never wipes the library', async (t) => {
  const s = await setup({ 'Keep.2001.mkv': 60 * MiB, 'Gone.2002.mkv': 61 * MiB });
  t.after(s.cleanup);
  await s.lib.scan();
  assert.equal(movies(s.lib).length, 2);
  await fsp.rm(path.join(s.tree.root, 'Gone.2002.mkv'));
  await s.lib.scan();
  assert.equal(movies(s.lib).length, 1);

  // "unplug the drive"
  const moved = s.tree.root + '-moved';
  await fsp.rename(s.tree.root, moved);
  await s.lib.scan();
  assert.equal(movies(s.lib).length, 1, 'library untouched');
  assert.equal(s.lib.state.folderMissing, true);
  assert.equal(lastProgress(s.events).error, 'FOLDER_MISSING');
  assert.equal(s.lib.publicLibrary().folderMissing, true);

  // plug it back in
  await fsp.rename(moved, s.tree.root);
  await s.lib.scan();
  assert.equal(s.lib.state.folderMissing, false);
  assert.equal(movies(s.lib).length, 1);
  assert.equal(s.tmdb.calls.search, 2, 'no lookups across the outage');
});

test('library: unreadable subfolder marks entries missing instead of deleting', async (t) => {
  const s = await setup({ 'Top.2001.mkv': 60 * MiB, 'Locked/Inside.2002.mkv': 61 * MiB });
  t.after(async () => {
    await fsp.chmod(path.join(s.tree.root, 'Locked'), 0o755).catch(() => {});
    await s.cleanup();
  });
  await s.lib.scan();
  assert.equal(movies(s.lib).length, 2);
  await fsp.chmod(path.join(s.tree.root, 'Locked'), 0o000);
  await s.lib.scan();
  assert.equal(movies(s.lib).length, 2, 'kept');
  assert.equal(byName(s.lib, 'Inside.2002.mkv').missing, true);
  await fsp.chmod(path.join(s.tree.root, 'Locked'), 0o755);
  await s.lib.scan();
  assert.equal(byName(s.lib, 'Inside.2002.mkv').missing, false);
});

test('library: network failure leaves entries pending and retries later', async (t) => {
  const s = await setup({ 'Net.2001.mkv': 60 * MiB, 'Net2.2002.mkv': 61 * MiB });
  t.after(s.cleanup);
  s.tmdb.failNext('NETWORK');
  await s.lib.scan();
  const pending = movies(s.lib).filter((m) => m.status === 'pending');
  assert.ok(pending.length >= 1, 'items stay pending');
  assert.ok(movies(s.lib).every((m) => m.status !== 'unmatched'), 'nothing marked unmatched by a network error');
  assert.equal(lastProgress(s.events).error, 'TMDB_UNREACHABLE');
  await s.lib.enrichPending();
  assert.ok(movies(s.lib).every((m) => m.status === 'matched'));
});

test('library: no API key -> unmatched, not pending forever; key later -> force rescan matches', async (t) => {
  const s = await setup({ 'Key.2001.mkv': 60 * MiB });
  t.after(s.cleanup);
  s.tmdb.hasKey = false;
  await s.lib.scan();
  assert.equal(movies(s.lib)[0].status, 'unmatched');
  assert.equal(lastProgress(s.events).error, 'NO_API_KEY');
  s.tmdb.hasKey = true;
  await s.lib.scan({ force: true });
  assert.equal(movies(s.lib)[0].status, 'matched');
});

test('library: truly unknown title ends unmatched; fixMatch survives rescan', async (t) => {
  const s = await setup({ 'Zzz.Unknown.2001.mkv': 60 * MiB });
  t.after(s.cleanup);
  s.tmdb.unknownTitles.add('Zzz Unknown');
  await s.lib.scan();
  assert.equal(movies(s.lib)[0].status, 'unmatched');
  const fixed = await s.lib.fixMatch(movies(s.lib)[0].id, 4242);
  assert.equal(fixed.status, 'matched');
  assert.equal(fixed.manualMatch, true);
  await s.lib.scan({ force: true });
  assert.equal(movies(s.lib)[0].tmdb.id, 4242, 'manual match not overwritten by force rescan');
});

test('library: changing the folder removes old entries', async (t) => {
  const s = await setup({ 'One.2001.mkv': 60 * MiB });
  t.after(s.cleanup);
  await s.lib.scan();
  const other = await buildSmallTree({ 'Two.2002.mkv': 60 * MiB });
  t.after(other.cleanup);
  await s.store.saveSettings({ moviesDir: other.root });
  await s.lib.scan();
  assert.deepEqual(movies(s.lib).map((m) => m.fileName), ['Two.2002.mkv']);
});

test('library: concurrent enrichPending calls share one pass (no duplicate lookups)', async (t) => {
  const s = await setup({ 'A.2001.mkv': 60 * MiB, 'B.2002.mkv': 61 * MiB, 'C.2003.mkv': 62 * MiB });
  t.after(s.cleanup);
  s.tmdb.hasKey = false;
  await s.lib.scan(); // everything unmatched, no calls
  s.tmdb.hasKey = true;
  for (const m of movies(s.lib)) m.status = 'pending';
  await Promise.all([s.lib.enrichPending(), s.lib.enrichPending(), s.lib.enrichPending()]);
  assert.equal(s.tmdb.calls.search, 3, 'each movie looked up exactly once');
  assert.equal(s.tmdb.calls.images, 6, 'each image downloaded exactly once');
  assert.ok(movies(s.lib).every((m) => m.status === 'matched' && m.posterFile));
});

test('library: matched entries with stale details get refreshed without a new search', async (t) => {
  const s = await setup({ 'Old.Match.2001.mkv': 60 * MiB });
  t.after(s.cleanup);
  await s.lib.scan();
  const m = movies(s.lib)[0];
  assert.equal(m.tmdb.originalLanguage, 'ml');
  // simulate a library written by an older version: no language, no metadataVersion
  delete m.tmdb.originalLanguage;
  delete m.tmdb.metadataVersion;
  await s.store.saveLibrary();
  const searches = s.tmdb.calls.search;
  const details = s.tmdb.calls.details;
  await s.lib.scan();
  assert.equal(s.tmdb.calls.search, searches, 'no new search');
  assert.equal(s.tmdb.calls.details, details + 1, 'one details refresh');
  assert.equal(movies(s.lib)[0].tmdb.originalLanguage, 'ml');
  assert.equal(movies(s.lib)[0].status, 'matched');
  await s.lib.scan();
  assert.equal(s.tmdb.calls.details, details + 1, 'refresh happens once');
});

test('library: languages from the file name are stored on the entry', async (t) => {
  const s = await setup({ 'Leo (2023) Tamil + Telugu + Hindi Multi Audio 1080p.mkv': 60 * MiB, 'Plain.2001.mkv': 61 * MiB });
  t.after(s.cleanup);
  await s.lib.scan();
  assert.deepEqual(byName(s.lib, 'Leo (2023) Tamil + Telugu + Hindi Multi Audio 1080p.mkv').parsed.languages, ['ta', 'te', 'hi']);
  assert.deepEqual(byName(s.lib, 'Plain.2001.mkv').parsed.languages, []);
});

test('library: overlapping scans coalesce and a queued rescan runs once', async (t) => {
  const s = await setup({ 'A.2001.mkv': 60 * MiB });
  t.after(s.cleanup);
  const p1 = s.lib.scan();
  const p2 = s.lib.scan({ force: true });
  assert.equal(p1, p2, 'second call returns the in-flight promise');
  await p1;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(movies(s.lib).length, 1);
});

test('store: corrupt library.json is recovered from backup', async (t) => {
  const s = await setup({ 'A.2001.mkv': 60 * MiB, 'B.2002.mkv': 61 * MiB });
  t.after(s.cleanup);
  await s.lib.scan();
  await s.store.saveLibrary(); // second write creates library.json.bak from the first
  await s.store.flush();
  await fsp.writeFile(path.join(s.userData, 'library.json'), '{"version":2,"movies":{"a":{"pa'); // truncated
  const store2 = new Store(s.userData);
  await store2.init();
  assert.equal(Object.keys(store2.getLibrary().movies).length, 2, 'restored from .bak');
  assert.ok(store2.notices.some((n) => n.type === 'recovered'));
  const files = await fsp.readdir(s.userData);
  assert.ok(files.some((f) => f.startsWith('library.json.corrupt-')), 'bad file kept aside');
  await store2.flush();
});

test('store: garbage settings and missing files never throw', async (t) => {
  const ud = await tmpDir('ml-ud2-');
  t.after(() => fsp.rm(ud, { recursive: true, force: true }));
  await fsp.writeFile(path.join(ud, 'settings.json'), 'not json');
  await fsp.writeFile(path.join(ud, 'library.json'), '[1,2,3]');
  const store = new Store(ud);
  await store.init();
  assert.equal(typeof store.getSettings().minFileSizeMB, 'number');
  assert.deepEqual(store.getLibrary().movies, {});
  await store.flush();
});

test('idFor is stable across partial suffixes', () => {
  assert.equal(idFor('/x/Movie.mkv'), idFor('/x/Movie.mkv.part'));
  assert.equal(idFor('/x/Movie.mkv'), idFor('/x/Movie.mkv.crdownload'));
  assert.notEqual(idFor('/x/Movie.mkv'), idFor('/y/Movie.mkv'));
});
