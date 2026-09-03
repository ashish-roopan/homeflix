// Renders the app icon with Electron (offscreen). Output: build/icon.png (2048px).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, webPreferences: { offscreen: true }, transparent: true, frame: false });
  const html = `<html><body style="margin:0;background:transparent">
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
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(path.join(__dirname, 'icon.png'), img.toPNG());
  console.log('icon.png written', img.getSize());
  app.quit();
});
