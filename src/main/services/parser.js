'use strict';
// Turns a downloaded movie's file/folder name into { title, year }.
// Uses parse-torrent-title for the heavy lifting, with pre-cleaning and
// fallbacks for the cases it misses (website prefixes, regional release tags,
// partial-download suffixes, numeric titles).

const path = require('path');

// Bump whenever parsing changes so existing library entries get re-parsed once.
const PARSER_VERSION = 5;

let ptt = null;
try {
  ptt = require('parse-torrent-title');
} catch {
  ptt = null;
}

// Tokens that are always release info, never part of a title.
const STRONG_TAGS = [
  '2160p', '1080p', '1080i', '720p', '576p', '480p', '360p', '4k', 'uhd', 'hdr', 'hdr10', 'hdr10+', 'dolby', 'vision',
  'bluray', 'blu-ray', 'bdrip', 'brrip', 'web-dl', 'webdl', 'webrip', 'hdrip', 'dvdrip', 'dvdscr', 'dvdscreener', 'screener',
  'hdtv', 'hdcam', 'camrip', 'telesync', 'telecine', 'hdtc', 'predvd', 'predvdrip', 'remux', 'untouched',
  'amzn', 'dsnp', 'hmax', 'atvp', 'hotstar', 'zee5', 'sonyliv', 'jio', 'netflix', 'primevideo',
  'x264', 'x265', 'h264', 'h.264', 'h265', 'h.265', 'hevc', 'avc', 'xvid', 'divx', 'av1', '10bit', '8bit',
  'aac', 'aac2.0', 'aac5.1', 'ac3', 'eac3', 'dd5.1', 'ddp5.1', 'ddp', 'dd+', 'dd+5.1', 'dts', 'dts-hd', 'truehd', 'atmos',
  'mp3', 'flac', '5.1', '7.1', '2.0', 'kbps',
  'proper', 'repack', 'rerip', 'extended', 'unrated', 'remastered', 'imax', 'theatrical',
  'multi', 'dubbed', 'subbed', 'esub', 'esubs', 'msubs', 'msub', 'hardsub', 'softsub',
  'hindi', 'tamil', 'telugu', 'malayalam', 'kannada', 'bengali', 'marathi', 'punjabi', 'gujarati',
  'korean', 'japanese', 'english', 'spanish', 'french', 'german', 'italian', 'chinese', 'russian',
  'yts', 'yify', 'rarbg', 'eztv', 'ettv', 'galaxyrg', 'tgx', 'fgt', 'sparks', 'evo', 'psa', 'pahe', 'tamilrockers', 'movierulz',
];
// Tokens that are usually tags but can be real words; only treated as tags when
// followed by another tag/year or when at the end of a name that already has a year.
const WEAK_TAGS = [
  'ts', 'tc', 'web', 'cam', 'dv', 'nf', 'dual', 'line', 'true', 'org', 'hc', 'hq', 'sub', 'subs', 'clean',
  'audio', 'auds', 'original', 'eng', 'hin', 'tam', 'tel', 'mal', 'kan', 'directors', 'cut', 'rip',
];

// Language words that appear in release names -> ISO 639-1 codes.
const LANGUAGE_TAGS = {
  hindi: 'hi', hin: 'hi', tamil: 'ta', tam: 'ta', telugu: 'te', tel: 'te', malayalam: 'ml', mal: 'ml',
  kannada: 'kn', kan: 'kn', bengali: 'bn', bangla: 'bn', marathi: 'mr', punjabi: 'pa', gujarati: 'gu', urdu: 'ur',
  korean: 'ko', kor: 'ko', japanese: 'ja', jap: 'ja', jpn: 'ja', english: 'en', eng: 'en', spanish: 'es', spa: 'es',
  french: 'fr', fre: 'fr', german: 'de', ger: 'de', italian: 'it', ita: 'it', chinese: 'zh', mandarin: 'zh', cantonese: 'zh',
  russian: 'ru', rus: 'ru', portuguese: 'pt', turkish: 'tr', thai: 'th', indonesian: 'id', arabic: 'ar', persian: 'fa',
};

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
const SIZE_TAG = '\\d+(?:\\.\\d+)?\\s?(?:mb|gb)|\\d+\\s?kbps';
const STRONG_TAG_RE = new RegExp(`(?<![\\w+])(?:${STRONG_TAGS.map(esc).join('|')}|${SIZE_TAG})(?![\\w+])`, 'i');
const WEAK_TAG_RE = new RegExp(`(?<![\\w+])(?:${WEAK_TAGS.map(esc).join('|')})(?![\\w+])`, 'i');
const ANY_TAG_RE = new RegExp(`(?<![\\w+])(?:${[...STRONG_TAGS, ...WEAK_TAGS].map(esc).join('|')}|${SIZE_TAG})(?![\\w+])`, 'i');
const STRONG_SET = new Set(STRONG_TAGS);
const WEAK_SET = new Set(WEAK_TAGS);

const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.m4v', '.webm', '.wmv', '.mpg', '.mpeg', '.ts', '.flv', '.m2ts']);
// Suffixes browsers/torrent clients add while a download is in progress.
const PARTIAL_EXTS = ['.part', '.crdownload', '.download', '.tmp', '.!qb', '.!ut', '.aria2', '.partial', '.bt!'];
const PARTIAL_RE = new RegExp(`(?:${PARTIAL_EXTS.map(esc).join('|')})+$`, 'i');

const GENERIC_NAMES = /^(movie|video|film|full|cd\s*\d+|disc\s*\d+|disk\s*\d+|part\s*\d+|pt\s*\d+|\d+|index|main|feature|untitled)$/i;
const YEAR_RE = /(?<!\d)(19[2-9]\d|20[0-4]\d)(?!\d)/g;
const DOMAIN_RE = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
// Website prefixes: "www.Site.tld - Title", "[www.Site.tld] - Title", "Site.yt - Title".
// A bare "Site.tld" (no www, no brackets) only counts with a TLD piracy sites actually use,
// so dotted release names like "The.Matrix.1999.1080p.BluRay.x264-GROUP" are left alone.
const SITE_TLDS = 'com|net|org|info|biz|io|co|in|me|tv|to|cc|ws|ru|re|yt|pics|shopping|software|bargains|bar|link|club|site|online|xyz|top|vip|pro|live|life|app|dev|world|fun|icu|buzz|guru|zone|lol|ltd|one|run|day|ink|mov|movie|movies|film|video|stream|pw|su|is|it|de|fr|la|ly|sh|sx|ag|ac|ai|am|at|be|by|ch|cx|cz|dk|es|eu|fi|gr|hu|ie|lt|lv|mx|nl|no|nu|pl|pt|se|si|sk|tw|uk|us|vn|za|ph|ms|pe|mn|rip|tel|st|gd|gg|cfd|sbs|cyou|quest|monster|rest|skin|homes|autos|boats|men|ninja|rocks|space|store|tech|tools|wiki|work|works|ist|cam|pics|money|cash|win|bid|trade|loan|download|torrent|pm|fm|gs|im|nz|ca|au|se';
const SEP = '(?:\\s+[-–—_]+\\s*|[-–—_]+\\s+|\\s+(?=[A-Z0-9]))';
const SITE_PREFIX_RE = new RegExp(
  '^\\s*(?:' +
    '[\\[(]\\s*(?:www\\.)?[a-z0-9-]+(?:\\.[a-z0-9-]+){0,3}\\.[a-z]{2,12}\\s*[\\])]\\s*(?:[-–—_]+\\s*)?' + // bracketed domain
    '|www\\.[a-z0-9-]+(?:\\.[a-z0-9-]+){0,3}\\.[a-z]{2,12}' + SEP + // www.anything.tld
    '|[a-z0-9-]+(?:\\.[a-z0-9-]+){0,2}\\.(?:' + SITE_TLDS + ')' + SEP + // site.knowntld
  ')',
  'i'
);

/** Remove .part / .crdownload / ... from a file name. */
function stripPartialSuffix(name) {
  return String(name).replace(PARTIAL_RE, '');
}

function isPartialName(name) {
  return PARTIAL_RE.test(String(name));
}

/** Video file, allowing for partial-download suffixes ("x.mkv.part" -> true). */
function isVideoFile(filePath) {
  const ext = path.extname(stripPartialSuffix(path.basename(filePath))).toLowerCase();
  return VIDEO_EXTS.has(ext);
}

/**
 * Parse a movie's absolute path. `rootDir` is the library root so that
 * a movie folder directly under it can lend its name to the file.
 * @returns {{ title: string, year: number|null, source: 'file'|'folder' }}
 */
function parseMoviePath(filePath, rootDir) {
  const fileName = stripPartialSuffix(path.basename(filePath));
  const base = path.basename(fileName, path.extname(fileName));
  const parentDir = path.dirname(filePath);
  const parentName = path.basename(parentDir);
  const rootResolved = rootDir ? path.resolve(rootDir) : null;
  const parentIsRoot = rootResolved && path.resolve(parentDir) === rootResolved;

  const fromFile = parseName(base);
  if (parentIsRoot || !parentName || parentDir === filePath) return { ...fromFile, source: 'file' };

  const fromFolder = parseName(parentName);
  const fileGeneric = !fromFile.title || fromFile.title.length < 2 || GENERIC_NAMES.test(fromFile.title);
  const folderUseful = fromFolder.title && fromFolder.title.length >= 2 && !GENERIC_NAMES.test(fromFolder.title);

  const languages = [...new Set([...(fromFile.languages || []), ...(fromFolder.languages || [])])];
  if (folderUseful && (fileGeneric || (fromFolder.year && !fromFile.year))) {
    return { ...fromFolder, languages, source: 'folder' };
  }
  return { ...fromFile, languages, source: 'file' };
}

/** Language codes mentioned in a release name (e.g. "Malayalam", "Hindi Dubbed", "Multi Audio Tam Tel"). */
function extractLanguages(rawName) {
  const out = [];
  for (const w of String(rawName).split(/[\s._\-\[\]()+,&]+/)) {
    const code = LANGUAGE_TAGS[w.toLowerCase()];
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

/** Parse a single bare name (no extension, no path). */
function parseName(rawName) {
  const languages = extractLanguages(rawName);
  const cleaned = preClean(rawName);
  if (!cleaned) return { title: '', year: null, languages };
  let title = '';
  let year = null;

  if (ptt) {
    try {
      const r = ptt.parse(cleaned);
      title = (r.title || '').trim();
      year = r.year ? Number(r.year) : null;
    } catch {
      /* fall through to regex */
    }
  }

  const fb = fallbackParse(cleaned);
  // ptt sometimes keeps a trailing tag or hands back a suspiciously short/empty title.
  if (!title || STRONG_TAG_RE.test(title) || /^\W*$/.test(title)) title = fb.title || title;
  if (!year && fb.year) {
    year = fb.year;
    if (fb.title && fb.title.length < title.length) title = fb.title;
  }
  // When both agree on the year, the text before the year is the most reliable title:
  // ptt may keep tags ("Dune Part Two 2160p") or drop real words it mistakes for tags ("The Web").
  if (fb.title && fb.year && year === fb.year) {
    const a = title.toLowerCase();
    const b = fb.title.toLowerCase();
    if (a !== b && (a.startsWith(b) || b.startsWith(a))) title = fb.title;
  }

  title = postClean(title);
  if (!title) title = postClean(fb.title) || postClean(cleaned);
  return { title, year, languages };
}

function preClean(name) {
  let s = stripPartialSuffix(String(name));
  // Leading "[Group]" (anime/scene release groups): "[SubsPlease] Show - 05".
  s = s.replace(/^\s*\[[^\]]{1,40}\]\s*/, '');
  // Telegram/forum handles glued to the front: "@MM_Links Angrezi Medium (2020)".
  s = s.replace(/^\s*@[\w.]+[_\s-]+/, '');
  // Website prefixes, possibly stacked: "www.Site.tld - [Site2.tld] - Title".
  for (let i = 0; i < 3; i++) {
    const next = s.replace(SITE_PREFIX_RE, '');
    if (next === s) break;
    s = next;
  }
  // "A Separation aka Jodaie Nader Az Simin 2011": drop the alias up to the year/tags.
  s = s.replace(/[ ._-]+aka[ ._-]+(?:(?!(?:19|20)\d{2}\b)[^\s._-]+[ ._-]*)*/i, ' ');
  // "Fight Club 10th Anniversary Edition 1999".
  s = s.replace(/\b\d+(?:st|nd|rd|th)[ ._-]+anniversary(?:[ ._-]+edition)?\b/i, ' ');
  // Bracketed groups that are pure release info or a domain (e.g. "[YTS.MX]", "(1080p)", "[www.Site.tld]").
  s = s.replace(/[\[({]([^\])}]*)[\])}]/g, (m, inner) => {
    const inn = inner.trim();
    if (/^(19|20)\d{2}$/.test(inn)) return ` ${inn} `; // keep "(2010)" as a year
    if (DOMAIN_RE.test(inn)) return ' ';
    const words = inn.split(/[\s._\-&,+]+/).filter(Boolean);
    const taggy = words.length && words.every((w) => isTagWord(w));
    return taggy ? ' ' : ` ${inn} `;
  });
  // Trailing "-GROUP" release group.
  s = s.replace(/-\s*[A-Za-z0-9]{2,20}$/, (m) => (ANY_TAG_RE.test(m) ? ' ' : ' '));
  s = s.replace(/[._]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function isTagWord(w) {
  const lw = w.toLowerCase();
  return STRONG_SET.has(lw) || WEAK_SET.has(lw) || /^\d{3,4}p$/i.test(w) || /^\d+(\.\d+)?(mb|gb)$/i.test(w) || /^\d+kbps$/i.test(w) || /^(19|20)\d{2}$/.test(w);
}

/** Regex-based parse used as a fallback and as a sanity check on ptt. */
function fallbackParse(s) {
  const years = [...s.matchAll(YEAR_RE)];
  let year = null;
  let cutAt = -1;
  for (let i = years.length - 1; i >= 0; i--) {
    const m = years[i];
    const after = s.slice(m.index + 4).trim();
    if (m.index === 0 && years.length > 1) continue; // "2012 2009 720p" -> title is "2012"
    const nextWord = after.split(/\s+/)[0] || '';
    if (!after || isTagWord(nextWord) || /^[-–—]/.test(after) || years.length === 1 || /^\W/.test(after)) {
      year = Number(m[1]);
      cutAt = m.index;
      break;
    }
  }
  let title = cutAt > 0 ? s.slice(0, cutAt) : s;
  if (cutAt === 0) {
    // Year at the very start, e.g. "2012 2009 720p" or "1917 2019".
    title = s.slice(0, 4);
    year = years.length > 1 ? Number(years[1][1]) : year;
  }
  title = cutAtTags(title);
  return { title: title.trim(), year };
}

/** Cut a title at the first release tag. Weak tags only count when followed by another tag/year. */
function cutAtTags(title) {
  const words = title.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/^[-–—]+|[-–—]+$/g, '');
    if (!w) continue;
    if (i === 0) continue; // never cut the first word; "Web", "Cam", "1080p" as a title is unlikely but a bare tag title is useless anyway
    const lw = w.toLowerCase();
    const strong = STRONG_SET.has(lw) || /^\d{3,4}p$/i.test(w) || /^\d+(\.\d+)?(mb|gb)$/i.test(w) || /^\d+kbps$/i.test(w);
    if (strong) return words.slice(0, i).join(' ');
    if (WEAK_SET.has(lw)) {
      // A weak tag only counts when another tag follows it ("Web 1080p"), never as the last word ("The Web").
      const next = (words[i + 1] || '').replace(/^[-–—]+|[-–—]+$/g, '');
      if (next && isTagWord(next)) return words.slice(0, i).join(' ');
    }
  }
  return title;
}

function postClean(title) {
  return String(title || '')
    .replace(/[\s\-–—:,|]+$/g, '')
    .replace(/^[\s\-–—:,|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- folder context

// Category folders say what everything beneath them is: "TV SERIES", "Anime Series", "Shows",
// "MALAYALAM MOVIES", "Bollywood". Every word must be a category, language or filler word, so a
// show called "The Morning Show" is not mistaken for one.
const SHOW_WORDS = new Set(['tv', 'series', 'serial', 'serials', 'show', 'shows', 'sitcom', 'sitcoms', 'kdrama', 'kdramas', 'webseries', 'miniseries']);
const MOVIE_WORDS = new Set(['movie', 'movies', 'film', 'films', 'cinema', 'bollywood', 'hollywood', 'tollywood', 'kollywood', 'mollywood', 'sandalwood']);
const FILLER_WORDS = new Set(['anime', 'web', 'indian', 'foreign', 'regional', 'new', 'latest', 'old', 'classic', 'classics', 'hd', '4k', 'kids', 'all', 'my', 'the', 'complete', 'collection', 'and', '&', 'dubbed']);
// Sub-folders that only refine a category ("Series/English/...", "Movies/2023/...", "Shows/A/...").
const SUBCATEGORY_RE = /^(?:\d{4}s?|[a-z]|#|misc|others?|new|old|classics?|hd|4k|1080p|720p|dubbed|subbed|kids|family|documentar(?:y|ies)|action|comedy|drama|thriller|horror|romance|sci-?fi|animation|animated|complete|collection)$/i;

/** 'show' | 'movie' | null for a folder name like "TV SERIES" or "MALAYALAM MOVIES". */
function folderCategory(name) {
  const words = String(name || '').toLowerCase().replace(/[._-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4) return null;
  let kind = null;
  for (const w of words) {
    if (SHOW_WORDS.has(w)) kind = kind || 'show';
    else if (MOVIE_WORDS.has(w)) kind = kind || 'movie';
    else if (!FILLER_WORDS.has(w) && !LANGUAGE_TAGS[w]) return null;
  }
  return kind;
}

/**
 * Folder context for a file: the deepest category folder above it (hint) and, under a show
 * category, the folder right below it that names the show ("TV SERIES/DEMON SLAYER/...").
 */
function pathContext(filePath, rootDir) {
  const root = rootDir ? path.resolve(rootDir) : null;
  const rel = root ? path.relative(root, path.dirname(filePath)) : '';
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { hint: null, showFolder: null, folders: [] };
  const folders = rel.split(/[\\/]+/).filter(Boolean);
  let hint = null;
  let catIndex = -1;
  folders.forEach((f, i) => {
    const c = folderCategory(f);
    if (c) {
      hint = c;
      catIndex = i;
    }
  });
  let showFolder = null;
  if (hint === 'show') {
    for (let i = catIndex + 1; i < folders.length; i++) {
      const f = folders[i];
      if (LANGUAGE_TAGS[f.toLowerCase()] || SUBCATEGORY_RE.test(f) || folderCategory(f)) continue;
      showFolder = f;
      break;
    }
  }
  return { hint, showFolder, folders };
}

// ---------------------------------------------------------------- TV episodes

// Patterns that carry both season and episode.
const SE_PATTERNS = [
  /(?<![A-Za-z0-9])[Ss](\d{1,2})[ ._-]?[Ee](\d{1,3})(?:[ ._-]?(?:[Ee]|-)(\d{1,3}))?(?![0-9])/, // S01E02, S01E02E03, S01E02-03
  /(?<![A-Za-z0-9])(\d{1,2})x(\d{1,3})(?:-(\d{1,3}))?(?![0-9])/i, // 1x02, 1x02-03
  /\b[Ss]eason[ ._-]?(\d{1,2})[ ._-]+(?:[Ee]pisode|[Ee]p)[ ._-]?(\d{1,3})\b/i, // Season 1 Episode 2
];
// Episode-only patterns; only trusted when the surrounding folders say "this is a show".
const EP_ONLY_PATTERNS = [
  /(?<![A-Za-z0-9])(?:[Ee]pisode|[Ee]p|[Ee])[ ._-]?(\d{1,4})(?![0-9])/,
  /^(\d{1,4})(?:[ ._-]|$)/, // "01 - Pilot.mkv"
];
const DASH_NUMBER_RE = /[ ._-]-[ ._]*(\d{1,4})(?=[ ._-]|$)/; // "Show Name - 05 [1080p]" (anime style)
const SEASON_FOLDER_RE = /^(?:season|series|saison|temporada|staffel|stagione|s)[ ._-]?(\d{1,2})(?:[ ._-]+.*)?$/i; // "Season 1", "S02", "Season 3 - 1080p"
const SEASON_PACK_RE = /(?<![A-Za-z0-9])[Ss](\d{1,2})(?![Ee]\d|[0-9])/; // "Show.Name.S01.1080p.WEB-DL"
const SPECIALS_FOLDER_RE = /^(?:specials?|extras?)$/i;

function matchSE(name) {
  for (const re of SE_PATTERNS) {
    const m = re.exec(name);
    if (m) return { season: Number(m[1]), episode: Number(m[2]), episodeEnd: m[3] ? Number(m[3]) : null, index: m.index, length: m[0].length };
  }
  return null;
}

function seasonFromFolder(name) {
  if (!name) return null;
  if (SPECIALS_FOLDER_RE.test(name.trim())) return 0;
  const m = SEASON_FOLDER_RE.exec(name.trim());
  if (m) return Number(m[1]);
  const pack = SEASON_PACK_RE.exec(name);
  if (pack) return Number(pack[1]);
  // "{Season 1}", "Modern Family Season 3 (1080p ...)": the season word anywhere in the folder name.
  const anywhere = /(?<![a-z])(?:season|series)[ ._-]?(\d{1,2})(?![0-9])/i.exec(name);
  if (anywhere) return Number(anywhere[1]);
  return null;
}

/** Strip season tokens from a folder name so "Show.Name.S01.1080p" -> show title. */
function showTitleFromFolder(name) {
  let n = String(name).replace(SEASON_PACK_RE, ' ');
  n = n.replace(/\b(?:season|series|saison|temporada|staffel|stagione)[ ._-]?\d{1,2}(?:[ ._-]*(?:-|to)[ ._-]*\d{1,2})?\b/gi, ' '); // "Season 1", "Season 1-9"
  n = n.replace(/\bmini[ ._-]?series\b/gi, ' ');
  n = n.replace(/\b(?:complete|full)[ ._-]?(?:series|season|collection)?\b/gi, ' ');
  // "Band Of Brothers - Action History 2001 Eng Subs 720p", "Kimetsu no Yaiba - Mugen Ressha-hen S02 (2021)":
  // when what follows a spaced dash is release info (has a year or tags), the title is what precedes it.
  const dash = /^(.{3,}?\S)\s+[-–—]\s+/.exec(n);
  if (dash && /[a-z]/i.test(dash[1])) {
    const rest = n.slice(dash[0].length);
    if (YEAR_RE.test(rest) || ANY_TAG_RE.test(rest)) {
      YEAR_RE.lastIndex = 0;
      const y = /(?<!\d)(19[2-9]\d|20[0-4]\d)(?!\d)/.exec(rest);
      n = dash[1] + (y ? ` (${y[1]})` : '');
    }
    YEAR_RE.lastIndex = 0;
  }
  return parseName(n);
}

/**
 * Detect a TV episode from the path.
 * `ctx` (from pathContext) carries the category hint: under "TV SERIES" bare episode numbers are
 * trusted and the show folder names the show; under "MOVIES" only explicit S01E02-style markers count.
 * @returns {null | { show:{title,year}, groupTitle:string|null, season:number, episode:number, episodeEnd:number|null, episodeTitle:string|null, languages:string[] }}
 */
function parseEpisodePath(filePath, rootDir, ctx = pathContext(filePath, rootDir)) {
  const hintShow = ctx.hint === 'show';
  const hintMovie = ctx.hint === 'movie';
  const fileName = stripPartialSuffix(path.basename(filePath));
  const base = path.basename(fileName, path.extname(fileName));
  const rootResolved = rootDir ? path.resolve(rootDir) : null;
  const parentDir = path.dirname(filePath);
  const parentName = path.resolve(parentDir) === rootResolved ? null : path.basename(parentDir);
  const grandDir = path.dirname(parentDir);
  const grandName = !parentName || path.resolve(grandDir) === rootResolved || grandDir === parentDir ? null : path.basename(grandDir);

  const languages = [...new Set([...extractLanguages(base), ...(parentName ? extractLanguages(parentName) : []), ...(grandName ? extractLanguages(grandName) : [])])];
  const parentSeason = seasonFromFolder(parentName);
  const grandSeason = seasonFromFolder(grandName);

  let season = null;
  let episode = null;
  let episodeEnd = null;
  let titlePart = '';
  let episodeTitle = null;
  let weak = false; // derived from a bare number only; the library demotes lone "episodes" back to movies

  const se = matchSE(base);
  if (se) {
    ({ season, episode, episodeEnd } = se);
    titlePart = base.slice(0, se.index);
    const after = base.slice(se.index + se.length);
    const et = parseName(after.replace(/^[ ._-]+/, ''));
    if (et.title && !/^\d+$/.test(et.title) && et.title.length > 1) episodeTitle = et.title;
  } else if (hintMovie) {
    return null; // a movie folder: only an explicit S01E02-style marker makes an episode
  } else if (hintShow || parentSeason !== null || (parentName && looksLikeShowFolder(parentName, base))) {
    // Inside a season folder ("Season 2/03 - Title.mkv", "S01/E04.mkv"), an all-episodes-in-one
    // show folder, or anywhere under a "TV SERIES"-style category.
    let m = null;
    for (const re of EP_ONLY_PATTERNS) {
      m = re.exec(base);
      if (m) break;
    }
    if (!m) {
      const d = DASH_NUMBER_RE.exec(base);
      if (d && hintShow) m = d;
      else if (d && parentName) {
        const before = parseName(base.slice(0, d.index)).title.toLowerCase();
        const folderTitle = showTitleFromFolder(parentName).title.toLowerCase();
        if (before && folderTitle && (before === folderTitle || folderTitle.startsWith(before) || before.startsWith(folderTitle))) m = d;
      }
    }
    if (!m) return null;
    weak = !hintShow && parentSeason === null && !/(?:[Ee]pisode|[Ee]p)[ ._-]?\d/.test(base);
    episode = Number(m[1]);
    season = parentSeason !== null ? parentSeason : 1;
    titlePart = base.slice(0, m.index);
    // "02 Band Of Brothers Episode 01 Currahee": a leading playlist index is not part of the title.
    if (m.index > 0) titlePart = titlePart.replace(/^\s*\d{1,3}[ ._-]+/, '');
    const after = base.slice(m.index + m[0].length);
    const et = parseName(after.replace(/^[ ._-]+/, ''));
    if (et.title && et.title.length > 1) episodeTitle = et.title;
  } else {
    return null;
  }

  // Show title: from the file name, else the folder that isn't a season folder.
  let show = parseName(titlePart);
  const generic = !show.title || show.title.length < 2 || GENERIC_NAMES.test(show.title) || /^(?:season|series)$/i.test(show.title);
  if (generic) {
    if (parentName && parentSeason === null) show = showTitleFromFolder(parentName);
    else if (grandName) show = showTitleFromFolder(grandName);
    else if (parentName) show = showTitleFromFolder(parentName);
  }
  // Under a category like "TV SERIES", the folder right below it names the show. It is the grouping
  // key, so differently named season packs ("Kimetsu no Yaiba (Demon Slayer) {Season 1}" and
  // "Kimetsu no Yaiba S02") collapse into one show, and when it reads cleanly it is the search title too.
  let groupTitle = null;
  if (hintShow && ctx.showFolder) {
    const folder = showTitleFromFolder(ctx.showFolder);
    if (folder.title && folder.title.length >= 2 && !GENERIC_NAMES.test(folder.title)) {
      groupTitle = folder.title;
      const clean = folder.title.split(/\s+/).length <= 5 && !/[-–—:|]/.test(folder.title);
      if (clean || !show.title) show = { ...folder, year: folder.year || show.year || null, languages: show.languages };
      else if (!show.year && folder.year) show = { ...show, year: folder.year };
    }
  }
  if (!show.title) return null;
  if (episodeTitle && episodeTitle.split(/\s+/).every((w) => isTagWord(w) || /^\d+$/.test(w))) episodeTitle = null;
  if (!show.year) {
    // Year often lives on the show folder: "Dark (2017)/Season 1/..."
    const folderYear = (grandName && showTitleFromFolder(grandName).year) || (parentName && showTitleFromFolder(parentName).year) || null;
    if (folderYear) show = { ...show, year: folderYear };
  }
  return { show: { title: show.title, year: show.year || null }, groupTitle, season, episode, episodeEnd, episodeTitle, languages, weak };
}

/** "Show Name/Show Name - 05.mkv" or "Show Name/Episode 5.mkv": is the parent plausibly a show folder? */
function looksLikeShowFolder(parentName, base) {
  const t = showTitleFromFolder(parentName).title;
  if (!t || GENERIC_NAMES.test(t)) return false;
  if (/(?<![A-Za-z0-9])(?:[Ee]pisode|[Ee]p)[ ._-]?\d{1,3}(?![0-9])/.test(base)) return true;
  if (/^\d{1,3}(?:[ ._-]|$)/.test(base)) return true;
  return DASH_NUMBER_RE.test(base);
}

/**
 * Parse any media path: a movie or a TV episode.
 * @returns {{kind:'movie', title, year, languages, source} | {kind:'episode', show, season, episode, episodeEnd, episodeTitle, languages}}
 */
function parseMediaPath(filePath, rootDir) {
  const ctx = pathContext(filePath, rootDir);
  const ep = parseEpisodePath(filePath, rootDir, ctx);
  if (ep) return { kind: 'episode', ...ep };
  return { kind: 'movie', ...parseMoviePath(filePath, rootDir) };
}

const JUNK_PATH_RE = /(^|[\\/])(sample|samples|trailer|trailers|extras|featurettes|behind[ ._-]the[ ._-]scenes|deleted[ ._-]scenes)([\\/]|$)|[\\/][^\\/]*\b(sample|trailer)\b[^\\/]*$/i;
function isJunkPath(filePath) {
  return JUNK_PATH_RE.test(filePath);
}

module.exports = {
  PARSER_VERSION,
  parseMoviePath,
  parseName,
  isVideoFile,
  isJunkPath,
  isPartialName,
  stripPartialSuffix,
  extractLanguages,
  LANGUAGE_TAGS,
  parseEpisodePath,
  parseMediaPath,
  pathContext,
  folderCategory,
  seasonFromFolder,
  VIDEO_EXTS,
  PARTIAL_EXTS,
};
