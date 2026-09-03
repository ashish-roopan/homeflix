// Renders the app icon with Electron (offscreen). Output: build/icon.png (1024px) + build/icon.ico.
// Run with: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
setTimeout(() => { console.error('make-icon: timed out'); app.exit(1); }, 30000).unref();
// A small window at a forced 4x scale captures the same pixels on any monitor
// (a 1024-point window gets clamped to the screen and the capture follows the display's DPI).
app.commandLine.appendSwitch('force-device-scale-factor', '4');
const SIZE = 240; // points; 4x scale -> 960 px, resized to 1024 (a full 1024 px would exceed a 1080p work area)
app.whenReady().then(main).catch((err) => { console.error('make-icon failed:', err); app.exit(1); });
async function main() {
  // Not offscreen: OSR paint events never arrive on some Windows GPUs. A hidden window still paints
  // (paintWhenInitiallyHidden); if the capture comes back empty the window is shown for a moment.
  const win = new BrowserWindow({ show: false, width: SIZE + 16, height: SIZE + 16, useContentSize: true, resizable: false, transparent: true, frame: false, paintWhenInitiallyHidden: true, webPreferences: { backgroundThrottling: false } });
  const html = `<html><body style="margin:0;background:transparent;zoom:${SIZE / 1024}">
  <style>
    .tile { position:relative; width:1024px; height:1024px; border-radius:228px; overflow:hidden;
      background: radial-gradient(120% 90% at 20% 0%, #4a0a10 0%, #1c0507 45%, #0b0b0c 100%); }
    .glow { position:absolute; inset:-10%; background: radial-gradient(circle at 50% 118%, rgba(229,9,20,0.55) 0%, rgba(229,9,20,0.12) 35%, transparent 60%); }
    .sheen { position:absolute; inset:0; background: linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.02) 40%, rgba(0,0,0,0) 60%); }
    /* Netflix-style ribbon "H": two uprights + a diagonal-ish crossbar with a red glow */
    .h { position:absolute; left:0; top:0; width:1024px; height:1024px; }
    .bar { position:absolute; background: linear-gradient(180deg, #ff2f39 0%, #e50914 55%, #a80812 100%); border-radius: 22px; box-shadow: 0 40px 90px rgba(229,9,20,0.35), 0 6px 0 rgba(0,0,0,0.25) inset; }
    .l { left:250px; top:186px; width:170px; height:652px; }
    .r { left:604px; top:186px; width:170px; height:652px; }
    .mid { left:420px; top:437px; width:184px; height:150px; border-radius: 0; box-shadow: none;
      background: linear-gradient(90deg, #a80812 0%, #e50914 50%, #a80812 100%); }
    .shade-l { position:absolute; left:420px; top:437px; width:60px; height:150px; background: linear-gradient(90deg, rgba(0,0,0,0.35), transparent); }
    .shade-r { position:absolute; left:544px; top:437px; width:60px; height:150px; background: linear-gradient(270deg, rgba(0,0,0,0.35), transparent); }
    .badge { position:absolute; left:668px; top:640px; width:200px; height:200px; border-radius:50%; background: #fff; box-shadow: 0 20px 50px rgba(0,0,0,0.6), 0 0 0 14px #120405; display:flex; align-items:center; justify-content:center; }
    .play { width:0; height:0; border-left:78px solid #e50914; border-top:48px solid transparent; border-bottom:48px solid transparent; margin-left:20px; }
    .edge { position:absolute; inset:0; border-radius:228px; box-shadow: inset 0 0 0 6px rgba(255,255,255,0.06), inset 0 -40px 80px rgba(0,0,0,0.35); }
  </style>
  <div class="tile">
    <div class="glow"></div>
    <div class="h">
      <div class="bar l"></div>
      <div class="bar mid"></div>
      <div class="shade-l"></div><div class="shade-r"></div>
      <div class="bar r"></div>
    </div>
    <div class="sheen"></div>
    <div class="badge"><div class="play"></div></div>
    <div class="edge"></div>
  </div></body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 600));
  const rect = { x: 0, y: 0, width: SIZE + 8, height: SIZE + 8 }; // over-capture, then crop: the bottom rows can be short
  let img = await win.webContents.capturePage(rect);
  if (img.isEmpty()) {
    win.show();
    await new Promise((r) => setTimeout(r, 800));
    img = await win.webContents.capturePage(rect);
  }
  if (img.isEmpty()) throw new Error('capturePage returned an empty image');
  img = img.crop({ x: 0, y: 0, width: SIZE * 4, height: SIZE * 4 }).resize({ width: 1024, height: 1024, quality: 'best' });
  fs.writeFileSync(path.join(__dirname, 'icon.png'), img.toPNG());
  console.log('icon.png written', img.getSize());
  // Windows icon: PNG-compressed entries at the standard sizes in one .ico container.
  const sizes = [256, 128, 64, 48, 32, 16];
  const pngs = sizes.map((s) => img.resize({ width: s, height: s, quality: 'best' }).toPNG());
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), buildIco(sizes, pngs));
  console.log('icon.ico written', sizes.join('/'));
  app.quit();
}

function buildIco(sizes, pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = header.length + dir.length;
  pngs.forEach((png, i) => {
    const s = sizes[i];
    const e = i * 16;
    dir.writeUInt8(s >= 256 ? 0 : s, e); // width (0 = 256)
    dir.writeUInt8(s >= 256 ? 0 : s, e + 1); // height
    dir.writeUInt8(0, e + 2); // palette
    dir.writeUInt8(0, e + 3); // reserved
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...pngs]);
}
