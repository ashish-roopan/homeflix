'use strict';
// Packages the app for the current platform with @electron/packager.
//   npm run dist                       -> dist/Homeflix-<platform>-<arch>/
//   DIST_PLATFORM=win32 DIST_ARCH=x64  -> cross-package (icons/metadata picked per platform)
const path = require('path');
const { pathToFileURL } = require('url');

// @electron/packager unzips Electron with a native helper that needs the Visual C++ runtime on
// Windows. If it can't load, route that one import to build/extract-zip-shim.mjs (system tar).
try {
  require('@electron-internal/extract-zip');
} catch (err) {
  const { registerHooks } = require('module');
  if (typeof registerHooks !== 'function') {
    console.error('The Electron unzip helper failed to load and this Node cannot shim it:\n' + err.message);
    console.error('Install the Visual C++ Redistributable (https://aka.ms/vs/17/release/vc_redist.x64.exe) or use Node 22.15+/24.');
    process.exit(1);
  }
  const shim = pathToFileURL(path.join(__dirname, 'extract-zip-shim.mjs')).href;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '@electron-internal/extract-zip') return { url: shim, format: 'module', shortCircuit: true };
      return next(specifier, context);
    },
  });
  console.log('note: using system tar to unzip Electron (native helper unavailable)');
}

const mod = require('@electron/packager');
const packager = mod.packager || mod;

const platform = process.env.DIST_PLATFORM || process.platform;
const arch = process.env.DIST_ARCH || process.arch;
const root = path.join(__dirname, '..');

const opts = {
  dir: root,
  name: 'Homeflix',
  platform,
  arch,
  out: path.join(root, 'dist'),
  overwrite: true,
  // build/ stays out except the icons (window icon on Windows/Linux) and, when present, the
  // gitignored default-key.json that seeds the TMDB key for installs that never had one set.
  ignore: [/^\/(test|dist|\.git|\.claude)($|\/)/, /^\/build\/(?!icon\.(ico|png)$|default-key\.json$)/, /\.command$/],
};

if (platform === 'darwin') {
  opts.icon = path.join(__dirname, 'icon.icns');
  opts.appBundleId = 'com.ashish.homeflix';
  opts.appCategoryType = 'public.app-category.entertainment';
} else if (platform === 'win32') {
  opts.icon = path.join(__dirname, 'icon.ico');
  opts.win32metadata = { CompanyName: 'Homeflix', ProductName: 'Homeflix', FileDescription: 'Homeflix', InternalName: 'Homeflix' };
} else {
  opts.icon = path.join(__dirname, 'icon.png');
}

packager(opts)
  .then((paths) => console.log('packaged:\n  ' + paths.join('\n  ')))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
