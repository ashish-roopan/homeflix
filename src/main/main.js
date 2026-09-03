'use strict';
const { app, BrowserWindow, protocol, session, dialog } = require('electron');
const path = require('path');
const fsp = require('fs/promises');

const { Store } = require('./services/store');
const { TmdbClient } = require('./services/tmdb');
const { LibraryService } = require('./services/library');
const { buildFileResponse } = require('./services/stream');
const { registerIpc } = require('./ipc');

// Test/dev override for where settings and the library live.
if (process.env.MOVIE_LAUNCHER_USER_DATA) app.setPath('userData', path.resolve(process.env.MOVIE_LAUNCHER_USER_DATA));

// media:// serves library videos (media://movie/<id>) and cached images
// (media://img/posters|backdrops/<file>). Nothing else.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
]);

let mainWindow = null;
let store, tmdb, library;
const perf = { t0: Date.now() };

// Only one Homeflix at a time: a second launch just focuses the existing window,
// so two processes never write the same library.json.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

process.on('unhandledRejection', (reason) => console.error('[main] unhandled rejection:', reason));
process.on('uncaughtException', (err) => console.error('[main] uncaught exception:', err));


function emitToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Homeflix',
    backgroundColor: '#141414',
    // macOS: hide the title bar but keep the traffic lights inset. Windows/Linux: hide it and
    // let Chromium draw the caption buttons over the top bar (styles.css pads the bar for them).
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } }
      : {
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#141414', symbolColor: '#ffffff', height: 48 },
          // Window/taskbar icon (macOS takes it from the .app bundle instead).
          icon: path.join(__dirname, '..', '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
        }),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.on('focus', () => library && library.onFocus());
  mainWindow.webContents.on('render-process-gone', (_e, details) => console.error('[main] renderer gone:', details.reason));

  // Dev aid: MOVIE_LAUNCHER_PRESCRIPT=/path.js runs in the page at dom-ready.
  if (process.env.MOVIE_LAUNCHER_PRESCRIPT) {
    mainWindow.webContents.on('dom-ready', async () => {
      const code = await fsp.readFile(process.env.MOVIE_LAUNCHER_PRESCRIPT, 'utf8');
      mainWindow.webContents.executeJavaScript(code, true).catch((e) => console.error('[dev] prescript failed', e));
    });
  }
  await mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.env.MOVIE_LAUNCHER_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Dev aid: MOVIE_LAUNCHER_SHOT=/path.png captures the window after a delay
  // (MOVIE_LAUNCHER_SHOT_DELAY ms, default 3000), then quits unless MOVIE_LAUNCHER_STAY=1.
  if (process.env.MOVIE_LAUNCHER_SHOT) {
    setTimeout(async () => {
      try {
        // Optional MOVIE_LAUNCHER_SCRIPT=/path.js runs in the page first (e.g. open a modal).
        if (process.env.MOVIE_LAUNCHER_SCRIPT) {
          const code = await fsp.readFile(process.env.MOVIE_LAUNCHER_SCRIPT, 'utf8');
          const out = await mainWindow.webContents.executeJavaScript(`(async () => { ${code} })()`, true);
          console.log('[dev] script result:', JSON.stringify(out));
          await new Promise((r) => setTimeout(r, Number(process.env.MOVIE_LAUNCHER_SCRIPT_WAIT) || 800));
        }
        const img = await mainWindow.webContents.capturePage();
        await fsp.writeFile(process.env.MOVIE_LAUNCHER_SHOT, img.toPNG());
        console.log('[dev] screenshot written to', process.env.MOVIE_LAUNCHER_SHOT);
      } catch (err) {
        console.error('[dev] screenshot failed', err);
      }
      if (!process.env.MOVIE_LAUNCHER_STAY) app.quit();
    }, Number(process.env.MOVIE_LAUNCHER_SHOT_DELAY) || 3000);
  }
}

function registerMediaProtocol() {
  const deny = (status = 404) => new Response('Not found', { status });

  protocol.handle('media', async (request) => {
    try {
      const url = new URL(request.url);
      const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);

      if (url.hostname === 'movie' && parts.length === 1) {
        const movie = store.getMovie(parts[0]);
        if (!movie) return deny();
        return await buildFileResponse(movie.path, request.headers.get('range'), request.method);
      }

      if (url.hostname === 'img' && parts.length === 2 && (parts[0] === 'posters' || parts[0] === 'backdrops')) {
        const dir = parts[0] === 'posters' ? store.postersDir : store.backdropsDir;
        const file = path.resolve(dir, path.basename(parts[1]));
        if (!file.startsWith(dir + path.sep)) return deny(403);
        return await buildFileResponse(file, null, request.method);
      }
      return deny(403);
    } catch (err) {
      console.error('[media] handler error', err);
      return new Response('Internal error', { status: 500 });
    }
  });
}

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'));
  try {
    await store.init();
  } catch (err) {
    console.error('[main] store init failed', err);
    dialog.showErrorBox('Homeflix could not start', `Could not read or create its data folder:\n${app.getPath('userData')}\n\n${err.message}`);
    app.quit();
    return;
  }
  tmdb = new TmdbClient(() => store.getSettings().tmdbApiKey);
  library = new LibraryService(store, tmdb, emitToRenderer);

  registerMediaProtocol();
  registerIpc({ store, tmdb, library });

  // Lock down the renderer: no remote content except TMDB images, tight CSP.
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' media:; img-src 'self' media: data: https://image.tmdb.org; media-src media:; style-src 'self' 'unsafe-inline'; script-src 'self'",
        ],
      },
    });
  });

  await createWindow();
  console.log(`[perf] window ready in ${Date.now() - perf.t0} ms`);
  library.refreshWatcher();
  // Scan on every launch, after the window is up so the cached library shows instantly.
  const t = Date.now();
  library
    .scan()
    .then(() => console.log(`[perf] initial scan+enrich in ${Date.now() - t} ms`))
    .catch((err) => console.error('[main] initial scan failed', err));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  (async () => {
    try {
      if (library) library.dispose();
      if (store) await store.flush();
    } catch (err) {
      console.error('[main] flush on quit failed', err);
    }
    app.quit();
  })();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
