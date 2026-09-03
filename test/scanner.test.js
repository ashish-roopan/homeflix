'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fsp = require('fs/promises');
const { scanDirectory, FolderMissingError } = require('../src/main/services/scanner');
const { buildHostileTree, tmpDir } = require('./fixtures');

test('scanner: hostile 1500-file tree', async (t) => {
  const fx = await buildHostileTree();
  t.after(fx.cleanup);

  const t0 = Date.now();
  const { files, failedDirs } = await scanDirectory(fx.root, { minFileSizeMB: 0 });
  const ms = Date.now() - t0;
  const partials = files.filter((f) => f.partial);
  const videos = files.filter((f) => !f.partial);
  const names = new Set(files.map((f) => path.basename(f.path)));

  assert.equal(videos.length, fx.expected.videosNoMin, 'regular video count');
  assert.equal(partials.length, fx.expected.partials, 'partials are indexed and flagged');
  assert.ok(!names.has('Bundle.Movie.2023.1080p.mkv'), 'Safari .download bundle skipped');
  assert.ok(!names.has('Zero.Byte.2020.1080p.mkv'), 'zero-byte skipped');
  assert.ok(!names.has('Deep.Fourteen.2001.mkv'), 'beyond depth limit skipped');
  assert.ok(names.has('Deep.Ten.2001.mkv'), 'depth 10 included');
  assert.ok(!names.has('sample.mkv') && !names.has('Some.Movie.2010-sample.mkv'), 'samples skipped');
  assert.ok(!names.has('Link.Movie.2015.mkv'), 'symlinks not followed');
  assert.ok(!files.some((f) => f.path.includes('/loop/')), 'symlink loop not followed');
  assert.ok(!files.some((f) => /\.(txt|nfo|jpg|srt|db|md|m3u|zip|dmg)$/i.test(f.path)), 'junk ignored');
  assert.ok(!files.some((f) => path.basename(f.path).startsWith('._')), 'AppleDouble files ignored');
  assert.equal(failedDirs.length, 1, 'one unreadable dir reported');
  assert.ok(failedDirs[0].endsWith('Locked'));
  assert.ok(files.every((f) => f.size > 0 && Number.isInteger(f.mtimeMs)));
  assert.ok(ms < 5000, `scan took ${ms} ms`);
  console.log(`  scanned ${files.length} files in ${ms} ms`);

  const min50 = await scanDirectory(fx.root, { minFileSizeMB: 50 });
  assert.equal(min50.files.filter((f) => !f.partial).length, fx.expected.videosMin50, 'size threshold drops the tiny clip');
  assert.equal(min50.files.filter((f) => f.partial).length, fx.expected.partials, 'partials bypass the size threshold');
});

test('scanner: missing folder throws FolderMissingError instead of returning empty', async () => {
  await assert.rejects(scanDirectory('/nonexistent/folder/xyz'), (e) => e instanceof FolderMissingError && e.code === 'FOLDER_MISSING');
});

test('scanner: root that is a file throws FolderMissingError', async (t) => {
  const d = await tmpDir();
  t.after(() => fsp.rm(d, { recursive: true, force: true }));
  const f = path.join(d, 'file.mkv');
  await fsp.writeFile(f, 'x');
  await assert.rejects(scanDirectory(f), (e) => e.code === 'FOLDER_MISSING');
});

test('scanner: unreadable root throws FolderMissingError', async (t) => {
  const d = await tmpDir();
  t.after(async () => {
    await fsp.chmod(d, 0o755);
    await fsp.rm(d, { recursive: true, force: true });
  });
  await fsp.chmod(d, 0o000);
  await assert.rejects(scanDirectory(d), (e) => e.code === 'FOLDER_MISSING');
});

test('scanner: empty folder returns no files, no error', async (t) => {
  const d = await tmpDir();
  t.after(() => fsp.rm(d, { recursive: true, force: true }));
  const r = await scanDirectory(d);
  assert.deepEqual(r, { files: [], failedDirs: [] });
});
