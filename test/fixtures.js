'use strict';
// Builds a deliberately hostile temporary movie tree for tests.
// Video files are sparse (truncate), so 1500 x 60 MiB costs no disk space on APFS.
// NTFS allocates the full size on truncate unless the file is flagged sparse first,
// so on Windows each big file is marked with `fsutil sparse setflag` before growing.

const fsp = require('fs/promises');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MiB = 1024 * 1024;
const IS_WIN = process.platform === 'win32';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => (err ? reject(new Error(`${cmd} ${args.join(' ')}: ${stderr || err.message}`)) : resolve(stdout)));
  });
}

// Bound the number of concurrent helper processes (1500 fixture files are created in parallel).
let inflight = 0;
const waiters = [];
async function limited(fn) {
  if (inflight >= 32) await new Promise((r) => waiters.push(r));
  inflight++;
  try {
    return await fn();
  } finally {
    inflight--;
    const next = waiters.shift();
    if (next) next();
  }
}

async function sparseFile(file, bytes) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  let fh = await fsp.open(file, 'w');
  try {
    if (bytes > 0) {
      if (IS_WIN && bytes >= MiB) {
        await fh.close();
        await limited(() => run('fsutil', ['sparse', 'setflag', file]));
        fh = await fsp.open(file, 'r+');
      }
      await fh.truncate(bytes);
    }
  } finally {
    await fh.close();
  }
}

/** Make a directory unlistable for the current user (chmod 000; on Windows an icacls deny ACE). */
async function lockDir(dir) {
  if (IS_WIN) await run('icacls', [dir, '/deny', `${os.userInfo().username}:(RD)`]);
  else await fsp.chmod(dir, 0o000);
}

/** Undo lockDir. Never throws. */
async function unlockDir(dir) {
  try {
    if (IS_WIN) await run('icacls', [dir, '/remove:d', os.userInfo().username]);
    else await fsp.chmod(dir, 0o755);
  } catch {
    /* already unlocked or gone */
  }
}

async function tmpDir(prefix = 'ml-test-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Create the big fixture tree.
 * @returns {Promise<{root:string, expected:{videos:number, partials:number}, unreadableDir:string, cleanup:()=>Promise<void>}>}
 */
async function buildHostileTree({ count = 1500, dirs = 30 } = {}) {
  const root = await tmpDir('ml-lib-');
  const jobs = [];

  // 1) count regular movies spread over `dirs` sub-folders, some folder-per-movie
  for (let i = 0; i < count; i++) {
    const d = `Folder ${i % dirs}`;
    const name = i % 7 === 0
      ? `Movie ${i} (${1950 + (i % 75)})/Movie.${i}.${1950 + (i % 75)}.1080p.BluRay.x264-GRP.mkv`
      : `Movie.${i}.${1950 + (i % 75)}.1080p.WEB-DL.x265.mkv`;
    jobs.push(sparseFile(path.join(root, d, name), 60 * MiB + i));
  }

  // 1b) a few TV shows in different layouts (episodes are separate files, not counted as movies)
  const showFiles = [];
  for (let e = 1; e <= 8; e++) showFiles.push(`Shows/Breaking Bad/Season 1/Breaking.Bad.S01E${String(e).padStart(2, '0')}.1080p.mkv`);
  for (let e = 1; e <= 6; e++) showFiles.push(`Shows/Breaking Bad/Season 2/Breaking.Bad.S02E${String(e).padStart(2, '0')}.1080p.mkv`);
  for (let e = 1; e <= 10; e++) showFiles.push(`Shows/Dark (2017)/Dark.S01E${String(e).padStart(2, '0')}.mkv`);
  for (let e = 1; e <= 5; e++) showFiles.push(`Shows/Panchayat/Season 2/${String(e).padStart(2, '0')} - Episode ${e}.mkv`);
  for (const f of showFiles) jobs.push(sparseFile(path.join(root, f), 60 * MiB));

  // 2) partial downloads of every flavour (kept, flagged partial)
  const partialExts = ['.part', '.crdownload', '.!qb'];
  let partials = 0;
  for (let i = 0; i < 20; i++) {
    for (const ext of partialExts) {
      jobs.push(sparseFile(path.join(root, 'Downloads', `www.Site.tld - Partial ${i}${ext === '.part' ? 'a' : ext === '.crdownload' ? 'b' : 'c'} (2024) Hindi HDRip - x264 - 400MB.mkv${ext}`), 10 * MiB));
      partials++;
    }
  }

  // 3) Safari bundle: a directory named X.mkv.download containing the growing file
  jobs.push(sparseFile(path.join(root, 'Downloads', 'Bundle.Movie.2023.1080p.mkv.download', 'Bundle.Movie.2023.1080p.mkv'), 30 * MiB));

  // 4) deep nesting: a file at depth 10 (counted) and at depth 14 (beyond limit, skipped)
  const deep = (n) => path.join(root, ...Array.from({ length: n }, (_, k) => `d${k}`));
  jobs.push(sparseFile(path.join(deep(10), 'Deep.Ten.2001.mkv'), 60 * MiB));
  jobs.push(sparseFile(path.join(deep(14), 'Deep.Fourteen.2001.mkv'), 60 * MiB));

  // 5) junk that must be ignored
  for (const j of ['notes.txt', 'movie.nfo', 'poster.jpg', 'subs.srt', '.DS_Store', '._Movie.1.mkv', 'Thumbs.db', 'readme.md', 'playlist.m3u', 'archive.zip', 'installer.dmg']) {
    jobs.push(fsp.writeFile(path.join(root, 'Folder 0', j), 'junk'));
  }

  // 6) zero-byte video (skipped)
  jobs.push(sparseFile(path.join(root, 'Folder 1', 'Zero.Byte.2020.1080p.mkv'), 0));

  // 7) two identical-size copies of one movie (both indexed; dedupe is a UI concern)
  jobs.push(sparseFile(path.join(root, 'Folder 2', 'Twin.Movie.2015.1080p.mkv'), 70 * MiB));
  jobs.push(sparseFile(path.join(root, 'Folder 3', 'Twin.Movie.2015.1080p.mkv'), 70 * MiB));

  // 8) sample/trailer dirs (skipped)
  jobs.push(sparseFile(path.join(root, 'Folder 4', 'Sample', 'sample.mkv'), 60 * MiB));
  jobs.push(sparseFile(path.join(root, 'Folder 4', 'Some.Movie.2010-sample.mkv'), 60 * MiB));

  // 9) tiny clip below the default 50 MB threshold
  jobs.push(sparseFile(path.join(root, 'Folder 5', 'Tiny.Clip.2019.mp4'), 2 * MiB));

  await Promise.all(jobs);

  // 10) symlink loop and a symlink to a file (neither followed). Windows: a junction needs no
  // privilege, a file symlink needs Developer Mode, so that one is best-effort.
  await fsp.symlink(IS_WIN ? root : '..', path.join(root, 'Folder 6', 'loop'), IS_WIN ? 'junction' : undefined);
  await fsp.symlink(path.join(root, 'Folder 2', 'Twin.Movie.2015.1080p.mkv'), path.join(root, 'Folder 6', 'Link.Movie.2015.mkv')).catch((err) => {
    if (!IS_WIN) throw err;
  });

  // 11) unreadable directory containing a video
  const unreadableDir = path.join(root, 'Locked');
  await sparseFile(path.join(unreadableDir, 'Locked.Movie.2012.mkv'), 60 * MiB);
  await lockDir(unreadableDir);

  const expected = {
    // regular movies + deep10 + twin x2 + tiny clip (only with minFileSizeMB=0) + episodes
    episodes: showFiles.length,
    videosNoMin: count + 1 + 2 + 1 + showFiles.length,
    videosMin50: count + 1 + 2 + showFiles.length,
    partials,
  };

  const cleanup = async () => {
    await unlockDir(unreadableDir);
    await fsp.rm(root, { recursive: true, force: true });
  };
  return { root, expected, unreadableDir, cleanup };
}

/** Small tree for library reconciliation tests. */
async function buildSmallTree(files) {
  const root = await tmpDir('ml-small-');
  for (const [rel, bytes] of Object.entries(files)) await sparseFile(path.join(root, rel), bytes);
  return { root, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

/** Fake TMDB client: deterministic matches, call counters, injectable failures. */
function mockTmdb() {
  const calls = { search: 0, details: 0, images: 0, tvSearch: 0, tvDetails: 0, seasons: 0 };
  let failNext = null;
  const idFor = (title) => 1000 + [...title].reduce((a, c) => a + c.charCodeAt(0), 0);
  const { TmdbError } = require('../src/main/services/tmdb');
  return {
    calls,
    hasKey: true,
    unknownTitles: new Set(),
    aliases: new Map(), // show title -> canonical title, so two names resolve to one TMDB id
    failNext(kind) {
      failNext = kind;
    },
    async findBest(title, year) {
      calls.search++;
      if (failNext) {
        const k = failNext;
        failNext = null;
        throw new TmdbError(k, `mock ${k}`);
      }
      if (this.unknownTitles.has(title)) return null;
      return { id: idFor(title), title, year };
    },
    async details(id) {
      calls.details++;
      const { METADATA_VERSION } = require('../src/main/services/tmdb');
      return { id, title: `T${id}`, year: 2000, overview: 'o', rating: 7, runtime: 100, genres: ['Drama'], tagline: '', posterPath: `/p${id}.jpg`, backdropPath: `/b${id}.jpg`, originalLanguage: 'ml', spokenLanguages: ['ml', 'ta'], metadataVersion: METADATA_VERSION };
    },
    async findBestTv(title, year) {
      calls.tvSearch++;
      if (failNext) {
        const k = failNext;
        failNext = null;
        throw new TmdbError(k, `mock ${k}`);
      }
      if (this.unknownTitles.has(title)) return null;
      const canonical = this.aliases.get(title) || title;
      return { id: 5000 + idFor(canonical), title: canonical, year };
    },
    async tvDetails(id) {
      calls.tvDetails++;
      const { METADATA_VERSION } = require('../src/main/services/tmdb');
      return { id, title: `Show${id}`, year: 2010, overview: 'tv', rating: 8, runtime: 45, genres: ['Drama', 'Crime'], tagline: '', posterPath: `/tp${id}.jpg`, backdropPath: `/tb${id}.jpg`, originalLanguage: 'en', spokenLanguages: ['en'], numberOfSeasons: 3, numberOfEpisodes: 30, showStatus: 'Ended', metadataVersion: METADATA_VERSION };
    },
    async seasonDetails(tvId, n) {
      calls.seasons++;
      if (n > 5) { const e = new TmdbError('NOT_FOUND', 'no such season'); throw e; }
      const episodes = {};
      for (let i = 1; i <= 10; i++) episodes[i] = { name: `Episode ${i} of S${n}`, overview: 'ep', stillPath: `/still${n}${i}.jpg`, airDate: `2010-0${n}-0${i}`, runtime: 45, rating: 7.5 };
      return { number: n, name: `Season ${n}`, overview: 'season', posterPath: null, airDate: `2010-0${n}-01`, episodes, fetchedAt: new Date().toISOString() };
    },
    async downloadImage(tmdbPath, size, destDir, stem) {
      calls.images++;
      const dest = path.join(destDir, `${stem}.jpg`);
      fs.writeFileSync(dest, 'img');
      return dest;
    },
  };
}

module.exports = { buildHostileTree, buildSmallTree, sparseFile, lockDir, unlockDir, tmpDir, mockTmdb, MiB };
