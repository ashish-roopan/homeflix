'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fsp = require('fs/promises');
const { buildFileResponse, parseRange } = require('../src/main/services/stream');
const { tmpDir, sparseFile } = require('./fixtures');

test('parseRange', () => {
  assert.deepEqual(parseRange(null, 100), { start: 0, end: 99, partial: false });
  assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99, partial: true });
  assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19, partial: true });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99, partial: true });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99, partial: true });
  assert.equal(parseRange('bytes=100-', 100).error, 416);
  assert.equal(parseRange('bytes=5-2', 100).error, 416);
  assert.equal(parseRange('bytes=abc', 100).error, 416);
  assert.equal(parseRange('bytes=-', 100).error, 416);
  assert.equal(parseRange('bytes=-0', 100).error, 416);
  const big = 4 * 1024 ** 3 + 12345;
  assert.deepEqual(parseRange('bytes=4294967000-', big), { start: 4294967000, end: big - 1, partial: true });
});

test('buildFileResponse', async (t) => {
  const d = await tmpDir();
  t.after(() => fsp.rm(d, { recursive: true, force: true }));
  const f = path.join(d, 'v.mp4');
  await fsp.writeFile(f, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));

  let r = await buildFileResponse(f, null);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.equal(r.headers.get('content-length'), '1000');
  assert.equal((await r.arrayBuffer()).byteLength, 1000);

  r = await buildFileResponse(f, 'bytes=100-199');
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 100-199/1000');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.length, 100);
  assert.equal(buf[0], 100);

  r = await buildFileResponse(f, 'bytes=-100');
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 900-999/1000');

  r = await buildFileResponse(f, 'bytes=9999-');
  assert.equal(r.status, 416);
  assert.equal(r.headers.get('content-range'), 'bytes */1000');

  r = await buildFileResponse(f, 'bytes=5-2');
  assert.equal(r.status, 416);

  r = await buildFileResponse(f, null, 'HEAD');
  assert.equal(r.status, 200);
  assert.equal(r.body, null);
  assert.equal(r.headers.get('content-length'), '1000');

  // zero-byte file: never throws
  const z = path.join(d, 'zero.mkv');
  await sparseFile(z, 0);
  r = await buildFileResponse(z, null);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-length'), '0');
  r = await buildFileResponse(z, 'bytes=0-');
  assert.equal(r.status, 416);

  // missing file
  r = await buildFileResponse(path.join(d, 'nope.mkv'), null);
  assert.equal(r.status, 404);

  // directory
  r = await buildFileResponse(d, null);
  assert.equal(r.status, 404);

  // huge sparse file: range near 4 GiB streams the right bytes
  const huge = path.join(d, 'huge.mkv');
  await sparseFile(huge, 4 * 1024 ** 3 + 64);
  r = await buildFileResponse(huge, 'bytes=4294967296-4294967359');
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 4294967296-4294967359/${4 * 1024 ** 3 + 64}`);
  assert.equal((await r.arrayBuffer()).byteLength, 64);
});
