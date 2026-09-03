'use strict';
// Serves a local file as a fetch Response with HTTP Range support so <video> can seek.
// Pure enough to unit test: buildFileResponse(filePath, rangeHeader, method).

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv', '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.flv': 'video/x-flv',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/** Parse "bytes=a-b" against a file size. Returns {start,end} or {error:416}. */
function parseRange(rangeHeader, size) {
  if (!rangeHeader) return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!m || (m[1] === '' && m[2] === '')) return { error: 416 };
  let start;
  let end = size - 1;
  if (m[1] === '') {
    // suffix range: last N bytes
    const n = Number(m[2]);
    if (!Number.isFinite(n) || n === 0) return { error: 416 };
    start = Math.max(0, size - n);
  } else {
    start = Number(m[1]);
    if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return { error: 416 };
  return { start, end, partial: true };
}

/**
 * @param {string} filePath
 * @param {string|null} rangeHeader
 * @param {string} [method]
 * @returns {Promise<Response>}
 */
async function buildFileResponse(filePath, rangeHeader, method = 'GET') {
  let st;
  try {
    st = await fsp.stat(filePath);
  } catch (err) {
    return new Response(err.code === 'EACCES' ? 'Forbidden' : 'Not found', { status: err.code === 'EACCES' ? 403 : 404 });
  }
  if (!st.isFile()) return new Response('Not found', { status: 404 });
  const size = st.size;
  const headers = { 'Content-Type': mimeFor(filePath), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (size === 0) {
    return new Response(null, { status: rangeHeader ? 416 : 200, headers: { ...headers, 'Content-Length': '0', ...(rangeHeader ? { 'Content-Range': 'bytes */0' } : {}) } });
  }
  const r = parseRange(rangeHeader, size);
  if (r.error) {
    return new Response('Range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const status = r.partial ? 206 : 200;
  if (r.partial) headers['Content-Range'] = `bytes ${r.start}-${r.end}/${size}`;
  headers['Content-Length'] = String(r.end - r.start + 1);
  if (method === 'HEAD') return new Response(null, { status, headers });

  const nodeStream = fs.createReadStream(filePath, { start: r.start, end: r.end });
  nodeStream.on('error', (err) => console.warn('[stream] read error', filePath, err.code || err.message));
  return new Response(Readable.toWeb(nodeStream), { status, headers });
}

module.exports = { buildFileResponse, parseRange, mimeFor };
