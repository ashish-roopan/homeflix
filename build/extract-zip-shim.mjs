// Drop-in for @electron-internal/extract-zip when its native binding can't load (Windows
// without the Visual C++ runtime). Same signature: extract(zipPath, { dir }). Uses the
// system tar, which understands zip on Windows 10+ (bsdtar) and macOS/Linux.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function extract(zipPath, opts) {
  if (!opts || !path.isAbsolute(opts.dir)) throw new TypeError('extract: opts.dir must be an absolute path');
  await fs.mkdir(opts.dir, { recursive: true });
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  await new Promise((resolve, reject) => {
    execFile(tar, ['-xf', zipPath, '-C', opts.dir], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) =>
      err ? reject(new Error(`${tar} failed: ${stderr || err.message}`)) : resolve()
    );
  });
}

export default extract;
