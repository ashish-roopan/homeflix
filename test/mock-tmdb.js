'use strict';
// Minimal TMDB mock for smoke tests: search, details, and generated PNG posters.
// Any title matches (deterministic id from the title), so a 1500-file library
// can be exercised offline. Usage: node test/mock-tmdb.js [port]
const http = require('http');
const zlib = require('zlib');

const PORT = Number(process.argv[2] || process.env.PORT || 45123);
const GENRES = ['Action', 'Drama', 'Comedy', 'Thriller', 'Science Fiction', 'Adventure', 'Animation', 'Horror', 'Romance', 'Crime'];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const idFor = (title) => 1000 + [...norm(title)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 900000, 7);
const colorFor = (id) => [(id * 37) % 200 + 30, (id * 59) % 200 + 30, (id * 83) % 200 + 30];

function png(w, h, [r, g, b]) {
  const crcT = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (buf) => { let c = ~0; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (~c) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const i = y * (w * 3 + 1) + 1 + x * 3; const f = 1 - 0.5 * (y / h); raw[i] = r * f; raw[i + 1] = g * f; raw[i + 2] = b * f; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const titles = new Map(); // id -> title
function result(title, year) {
  const id = idFor(title);
  titles.set(id, title);
  return {
    id, title, original_title: title, release_date: `${year || 2000 + (id % 25)}-01-01`,
    overview: `${title} is a mock film used to exercise the layout. Nothing here is real.`,
    vote_average: 5 + (id % 40) / 10, popularity: 50, poster_path: `/p${id}.jpg`, backdrop_path: `/b${id}.jpg`,
  };
}

let slow = 0; // ms of artificial latency (set via /__slow/<ms>)
let failMode = null; // '500' | 'timeout' | null (set via /__fail/<mode>)
let requests = 0;

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith('/__')) requests++;
  let m;
  if ((m = u.pathname.match(/^\/__slow\/(\d+)$/))) { slow = Number(m[1]); return res.end('ok'); }
  if ((m = u.pathname.match(/^\/__fail\/(\w+)$/))) { failMode = m[1] === 'none' ? null : m[1]; return res.end('ok'); }
  if (u.pathname === '/__stats') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ requests })); }
  if (slow) await new Promise((r) => setTimeout(r, slow));
  if (failMode === '500') { res.statusCode = 500; return res.end('boom'); }
  if (failMode === 'timeout') return; // never respond

  if (u.pathname === '/3/search/movie') {
    const q = u.searchParams.get('query') || '';
    const year = u.searchParams.get('year');
    const results = /unknown|zzz/i.test(q) ? [] : [result(q, year ? Number(year) : null)];
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ results }));
  }
  if (u.pathname === '/3/search/tv') {
    const q = u.searchParams.get('query') || '';
    const year = u.searchParams.get('first_air_date_year');
    const results = /unknown|zzz/i.test(q) ? [] : [(() => { const r = result(q, year ? Number(year) : null); return { ...r, id: r.id + 500000, name: r.title, original_name: r.title, first_air_date: r.release_date }; })()];
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ results }));
  }
  if ((m = u.pathname.match(/^\/3\/tv\/(\d+)\/season\/(\d+)$/))) {
    const n = Number(m[2]);
    const episodes = Array.from({ length: 10 }, (_, i) => ({ episode_number: i + 1, name: `Episode ${i + 1}`, overview: `Mock overview for S${n}E${i + 1}.`, still_path: `/b${m[1]}.jpg`, air_date: `2015-01-${String(i + 1).padStart(2, '0')}`, runtime: 42, vote_average: 7.5 }));
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ season_number: n, name: `Season ${n}`, overview: 'Mock season.', poster_path: null, air_date: '2015-01-01', episodes }));
  }
  if ((m = u.pathname.match(/^\/3\/tv\/(\d+)$/))) {
    const id = Number(m[1]);
    const title = titles.get(id - 500000) || `Show ${id}`;
    const r = result(title);
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ...r, id, name: title, original_name: title, first_air_date: r.release_date, episode_run_time: [45], number_of_seasons: 3, number_of_episodes: 30, status: 'Ended', genres: [{ id: 1, name: 'Drama' }], tagline: '' }));
  }
  if ((m = u.pathname.match(/^\/3\/movie\/(\d+)$/))) {
    const id = Number(m[1]);
    const title = titles.get(id) || `Movie ${id}`;
    const r = result(title);
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ...r, id, runtime: 90 + (id % 80), genres: [GENRES[id % GENRES.length], GENRES[(id >> 3) % GENRES.length]].filter((g, i, a) => a.indexOf(g) === i).map((name, i) => ({ id: i, name })), tagline: 'A mock tagline.' }));
  }
  if ((m = u.pathname.match(/^\/img\/(\w+)\/([pb])(\d+)\.jpg$/))) {
    res.setHeader('content-type', 'image/png');
    const c = colorFor(Number(m[3]));
    return res.end(m[2] === 'p' ? png(120, 180, c) : png(320, 180, c));
  }
  res.statusCode = 404;
  res.end('nope');
}).listen(PORT, () => console.log(`mock tmdb on ${PORT}`));
