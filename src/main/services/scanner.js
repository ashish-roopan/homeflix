'use strict';
// Walks the movies folder for video files and watches it for changes.

const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const { isVideoFile, isJunkPath, isPartialName } = require('./parser');

const SKIP_DIRS = new Set(['node_modules', '.git', '@eaDir', '.Trash', '.Trashes', '.Spotlight-V100', '.fseventsd', '$RECYCLE.BIN', 'System Volume Information']);
const MAX_DEPTH = 12;
const STAT_BATCH = 32;
const DIR_CONCURRENCY = 8;

class FolderMissingError extends Error {
  constructor(dir, cause) {
    super(`Movies folder not accessible: ${dir} (${cause && cause.code ? cause.code : 'unknown'})`);
    this.code = 'FOLDER_MISSING';
    this.dir = dir;
    this.cause = cause;
  }
}

/**
 * Recursively list candidate video files.
 * Throws FolderMissingError if the root itself can't be read, so callers never
 * mistake "drive unplugged" for "folder is empty".
 * @returns {Promise<{files: Array<{path,size,mtimeMs,partial}>, failedDirs: string[]}>}
 */
async function scanDirectory(rootDir, { minFileSizeMB = 0 } = {}) {
  const root = path.resolve(rootDir);
  let rootStat;
  try {
    rootStat = await fsp.stat(root);
  } catch (err) {
    throw new FolderMissingError(root, err);
  }
  if (!rootStat.isDirectory()) throw new FolderMissingError(root, { code: 'ENOTDIR' });
  try {
    await fsp.access(root, fs.constants.R_OK | fs.constants.X_OK);
  } catch (err) {
    throw new FolderMissingError(root, err);
  }

  const files = [];
  const failedDirs = [];
  const minBytes = Math.max(0, Number(minFileSizeMB) || 0) * 1024 * 1024;

  // Simple work queue with bounded concurrency over directories.
  const queue = [{ dir: root, depth: 0 }];
  let active = 0;
  let rootError = null; // set when the root itself can't be listed (ACL denial on Windows passes fs.access)
  await new Promise((resolve) => {
    const pump = () => {
      while (active < DIR_CONCURRENCY && queue.length) {
        const job = queue.shift();
        active++;
        readDir(job.dir, job.depth)
          .catch((err) => console.warn('[scanner] unexpected error in', job.dir, err.message))
          .finally(() => {
            active--;
            if (!queue.length && active === 0) resolve();
            else pump();
          });
      }
    };
    pump();
  });
  if (rootError) throw new FolderMissingError(root, rootError);

  async function readDir(dir, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (depth === 0) {
        rootError = err;
        return;
      }
      failedDirs.push(dir);
      console.warn('[scanner] cannot read', dir, err.code || err.message);
      return;
    }
    const toStat = [];
    for (const ent of entries) {
      const name = ent.name;
      if (name.startsWith('.') || name.startsWith('._') || name.startsWith('~$')) continue;
      const full = path.join(dir, name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (/\.download$/i.test(name)) continue; // Safari in-progress download bundle
        if (depth + 1 > MAX_DEPTH) continue;
        queue.push({ dir: full, depth: depth + 1 });
      } else if (ent.isFile() || (!ent.isSymbolicLink() && !ent.isDirectory())) {
        // Regular files, plus unknown types (some network mounts) which we stat to find out.
        if (!isVideoFile(full) || isJunkPath(full)) continue;
        toStat.push(full);
      }
      // Symlinks are deliberately not followed: no loops, no surprises.
    }
    for (let i = 0; i < toStat.length; i += STAT_BATCH) {
      const batch = toStat.slice(i, i + STAT_BATCH);
      const stats = await Promise.all(batch.map((f) => fsp.stat(f).catch(() => null)));
      for (let j = 0; j < batch.length; j++) {
        const st = stats[j];
        if (!st || !st.isFile()) continue;
        if (st.size === 0) continue;
        const partial = isPartialName(path.basename(batch[j]));
        if (!partial && st.size < minBytes) continue;
        files.push({ path: batch[j], size: st.size, mtimeMs: Math.round(st.mtimeMs), partial });
      }
    }
  }

  return { files, failedDirs };
}

/**
 * Watch a folder (recursively) and call `onChange` after a quiet period.
 * Re-attaches automatically if the folder disappears and comes back.
 * Returns a dispose function.
 */
function watchDirectory(rootDir, onChange, { debounceMs = 2500, retryMs = 10000 } = {}) {
  let timer = null;
  let watcher = null;
  let retry = null;
  let disposed = false;

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => onChange(), debounceMs);
  };

  const attach = () => {
    if (disposed) return;
    try {
      watcher = fs.watch(rootDir, { recursive: true, persistent: false }, (eventType, filename) => {
        const f = filename ? String(filename) : '';
        // Ignore churn on non-video files; partials count because they become videos.
        if (!f || isVideoFile(f) || eventType === 'rename') schedule();
      });
      watcher.on('error', (err) => {
        console.warn('[scanner] watch error, will retry:', err.message);
        detach();
        scheduleRetry();
      });
    } catch (err) {
      console.warn('[scanner] cannot watch', rootDir, err.message);
      scheduleRetry();
    }
  };

  const detach = () => {
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
      watcher = null;
    }
  };

  const scheduleRetry = () => {
    if (disposed) return;
    clearTimeout(retry);
    retry = setTimeout(async () => {
      try {
        const st = await fsp.stat(rootDir);
        if (st.isDirectory()) {
          attach();
          onChange(); // folder came back: rescan
          return;
        }
      } catch {
        /* still missing */
      }
      scheduleRetry();
    }, retryMs);
  };

  attach();
  return () => {
    disposed = true;
    clearTimeout(timer);
    clearTimeout(retry);
    detach();
  };
}

module.exports = { scanDirectory, watchDirectory, FolderMissingError };
